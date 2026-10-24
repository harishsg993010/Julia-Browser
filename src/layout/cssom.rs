//! CSSOM declaration blocks backed by Stylo (host op `cssdecl`).
//!
//! `element.style`, rule styles and `CSS.supports()` hand their declarations to Stylo — the same
//! parser the layout engine uses — so values are validated per property grammar and serialized
//! the CSSOM way (canonical specified values, shorthand reconstruction, `!important`). The page
//! side keeps a declaration block as its serialized text; every operation re-parses that text,
//! applies the change and answers the new serialization plus the longhand list.
//!
//! Payload `{op, text, prop, value, important, base, quirks}`; ops: `parse`, `set`, `remove`,
//! `get`, `supports` (`prop`+`value`, or `cond` for the one-argument form).

use cssparser::{Parser, ParserInput};
use serde_json::{json, Value};
use style::context::QuirksMode;
use style::parser::ParserContext;
use style::properties::{
    parse_one_declaration_into, parse_style_attribute, Importance, PropertyDeclarationBlock, PropertyId,
    SourcePropertyDeclaration,
};
use style::stylesheets::supports_rule::parse_condition_or_declaration;
use style::stylesheets::{CssRuleType, Origin, UrlExtraData};
use style_traits::ParsingMode;

pub(crate) fn url_data(base: Option<&str>) -> UrlExtraData {
    let url = base
        .and_then(|b| url::Url::parse(b).ok())
        .unwrap_or_else(|| url::Url::parse("about:blank").expect("about:blank parses"));
    UrlExtraData::from(url)
}

fn context(url: &UrlExtraData, quirks: QuirksMode) -> ParserContext<'_> {
    ParserContext::new(
        Origin::Author,
        url,
        Some(CssRuleType::Style),
        ParsingMode::DEFAULT,
        quirks,
        Default::default(),
        None,
        None,
        Default::default(),
    )
}

fn describe(block: &PropertyDeclarationBlock) -> Value {
    let mut css = String::new();
    let _ = block.to_css(&mut css);
    let list: Vec<Value> = block
        .declaration_importance_iter()
        .map(|(decl, imp)| {
            let mut v = String::new();
            let _ = decl.to_css(&mut v);
            json!([decl.id().name().into_owned(), v, imp.important()])
        })
        .collect();
    json!({"css": css, "list": list})
}

/// Stylo features the layout engine turns on when it creates a document (blitz-dom); the CSSOM
/// can be used before any layout exists, so they are enabled here too.
fn enable_features() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        style_config::set_pref!("layout.grid.enabled", true);
        style_config::set_pref!("layout.unimplemented", true);
        style_config::set_pref!("layout.columns.enabled", true);
        style_config::set_pref!("layout.css.basic-shape-shape.enabled", true);
        // web-exposed in current browsers: accept them in the CSSOM too
        style_config::set_pref!("layout.container-queries.enabled", true);
        style_config::set_pref!("layout.css.anchor-positioning.enabled", true);
        style_config::set_pref!("layout.css.at-scope.enabled", true);
        style_config::set_pref!("layout.css.attr.enabled", true);
        style_config::set_pref!("layout.css.content.alt-text.enabled", true);
        style_config::set_pref!("layout.css.font-palette.enabled", true);
        style_config::set_pref!("layout.css.font-tech.enabled", true);
        style_config::set_pref!("layout.css.light-dark.images.enabled", true);
        style_config::set_pref!("layout.css.progress-function.enabled", true);
        style_config::set_pref!("layout.css.properties-and-values.enabled", true);
        style_config::set_pref!("layout.css.starting-style-at-rules.enabled", true);
        style_config::set_pref!("layout.css.style-queries.enabled", true);
        style_config::set_pref!("layout.css.text-decoration-inset-percentage.enabled", true);
        style_config::set_pref!("layout.css.tree-counting-functions.enabled", true);
        style_config::set_pref!("layout.variable_fonts.enabled", true);
        style_config::set_pref!("layout.writing-mode.enabled", true);
    });
}

pub fn handle(payload: &Value) -> Value {
    enable_features();
    let op = payload.get("op").and_then(Value::as_str).unwrap_or("");
    let text = payload.get("text").and_then(Value::as_str).unwrap_or("");
    let quirks = if payload.get("quirks").and_then(Value::as_bool).unwrap_or(false) { QuirksMode::Quirks } else { QuirksMode::NoQuirks };
    let url = url_data(payload.get("base").and_then(Value::as_str));
    let parse_block = |t: &str| parse_style_attribute(t, &url, None, quirks, CssRuleType::Style);
    let ctx = context(&url, quirks);
    let prop_id = |name: &str| PropertyId::parse(name, &ctx).ok();
    let parse_value = |id: PropertyId, value: &str| -> Option<SourcePropertyDeclaration> {
        let mut src = SourcePropertyDeclaration::default();
        parse_one_declaration_into(&mut src, id, value, Origin::Author, &url, None, ParsingMode::DEFAULT, quirks, CssRuleType::Style).ok()?;
        Some(src)
    };
    let prop = payload.get("prop").and_then(Value::as_str).unwrap_or("");
    match op {
        "parse" => describe(&parse_block(text)),
        "set" => {
            let value = payload.get("value").and_then(Value::as_str).unwrap_or("");
            let Some(id) = prop_id(prop) else { return json!({"invalid": true, "unknown": true}) };
            let Some(mut src) = parse_value(id, value) else { return json!({"invalid": true}) };
            let mut block = parse_block(text);
            let imp = if payload.get("important").and_then(Value::as_bool).unwrap_or(false) { Importance::Important } else { Importance::Normal };
            block.extend(src.drain(), imp);
            describe(&block)
        }
        "remove" => {
            let Some(id) = prop_id(prop) else { return json!({"old": "", "unchanged": true}) };
            let mut block = parse_block(text);
            let mut old = String::new();
            let _ = block.property_value_to_css(&id, &mut old);
            match block.first_declaration_to_remove(&id) {
                Some(first) => {
                    block.remove_property(&id, first);
                    let mut d = describe(&block);
                    d["old"] = json!(old);
                    d
                }
                None => json!({"old": old, "unchanged": true}),
            }
        }
        "get" => {
            let Some(id) = prop_id(prop) else { return json!({"value": "", "important": false}) };
            let block = parse_block(text);
            let mut v = String::new();
            let _ = block.property_value_to_css(&id, &mut v);
            json!({"value": v, "important": block.property_priority(&id).important()})
        }
        "known" => json!(prop_id(prop).is_some()),
        // a media query list as CSSOM serializes it ("not all" for an invalid query)
        "media" => {
            let mut mctx = ParserContext::new(Origin::Author, &url, Some(CssRuleType::Media), ParsingMode::DEFAULT, quirks, Default::default(), None, None, Default::default());
            let mut input = ParserInput::new(text);
            let mut parser = Parser::new(&mut input);
            let list = style::media_queries::MediaList::parse(&mut mctx, &mut parser);
            json!({"text": style_traits::ToCss::to_css_string(&list)})
        }
        "supports" => {
            if let Some(cond) = payload.get("cond").and_then(Value::as_str) {
                let mut input = ParserInput::new(cond);
                let mut parser = Parser::new(&mut input);
                let ok = parser.parse_entirely(parse_condition_or_declaration).map(|c| c.eval(&ctx)).unwrap_or(false);
                return json!(ok);
            }
            let value = payload.get("value").and_then(Value::as_str).unwrap_or("");
            json!(prop_id(prop).and_then(|id| parse_value(id, value)).is_some())
        }
        // CSS.registerProperty() checks: the syntax definition and the initial value
        // (Stylist::register_custom_property without the registry): "ok" or the failure kind
        "register" => {
            use style::properties_and_values::registry::PropertyRegistration;
            use style::properties_and_values::rule::PropertyRegistrationError;
            use style::properties_and_values::syntax::Descriptor;
            let syntax = payload.get("syntax").and_then(Value::as_str).unwrap_or("*");
            let Ok(desc) = Descriptor::from_str(syntax, false) else { return json!("syntax") };
            let initial = match payload.get("initial").and_then(Value::as_str) {
                Some(v) => {
                    let mut input = ParserInput::new(v);
                    let parsed = Parser::new(&mut input)
                        .parse_entirely(|input| {
                            input.skip_whitespace();
                            style::custom_properties::SpecifiedValue::parse(input, None, &url).map(std::sync::Arc::new)
                        })
                        .ok();
                    match parsed {
                        Some(p) => Some(p),
                        None => return json!("initial"),
                    }
                }
                None => None,
            };
            match PropertyRegistration::validate_initial_value(&desc, initial.as_deref()) {
                Ok(()) => json!("ok"),
                Err(PropertyRegistrationError::NoInitialValue) => json!("missing"),
                Err(PropertyRegistrationError::InitialValueNotComputationallyIndependent) => json!("dependent"),
                Err(_) => json!("initial"),
            }
        }
        _ => json!({"error": format!("unknown cssdecl op {op}")}),
    }
}
