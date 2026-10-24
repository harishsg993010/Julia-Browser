// ---- Document.execCommand / queryCommand* (backed by 67_editing.js) ----
// Commands run against the realm's own document (its selection is the active range). A command
// that changed an editing host fires a trusted `input` event at it with the Input Events
// inputType of the command.
(function () {
  if (globalThis.__jb_workerRealm || !__jb.editing) return;
  var E = __jb.editing;
  var INPUT_TYPES = {
    backcolor: "formatBackColor", bold: "formatBold", createlink: "insertLink", "delete": "deleteContentBackward",
    fontname: "formatFontName", fontsize: "formatFontSize", forecolor: "formatFontColor", formatblock: "formatBlock",
    forwarddelete: "deleteContentForward", hilitecolor: "formatBackColor", indent: "formatIndent",
    inserthorizontalrule: "insertHorizontalRule", inserthtml: "insertHTML", insertimage: "insertImage",
    insertlinebreak: "insertLineBreak", insertorderedlist: "insertOrderedList", insertparagraph: "insertParagraph",
    inserttext: "insertText", insertunorderedlist: "insertUnorderedList", italic: "formatItalic",
    justifycenter: "formatJustifyCenter", justifyfull: "formatJustifyFull", justifyleft: "formatJustifyLeft",
    justifyright: "formatJustifyRight", outdent: "formatOutdent", removeformat: "formatRemove",
    strikethrough: "formatStrikeThrough", subscript: "formatSubscript", superscript: "formatSuperscript",
    underline: "formatUnderline", unlink: "formatRemoveLink",
  };
  var editingHostOf = function (node) {
    for (var n = node; n; n = n.parentNode) if (E.isEditingHost(n)) return n;
    return null;
  };
  var own = function (doc) { return doc === __jb.currentDocument; };
  // plaintext-only editing hosts take text, deletions and line breaks only
  var PLAINTEXT_OK = { inserttext: 1, "delete": 1, forwarddelete: 1, insertlinebreak: 1, insertparagraph: 1, selectall: 1, copy: 1, cut: 1, paste: 1, undo: 1, redo: 1, stylewithcss: 1, usecss: 1, defaultparagraphseparator: 1 };
  var plaintextHost = function () {
    var r = null; try { r = E.getActiveRange(); } catch (e) { r = null; }
    var h = r ? editingHostOf(r.startContainer) : null;
    return h && h.contentEditable === "plaintext-only" ? h : null;
  };
  var preservesNewlines = function (el) {
    var ws = ""; try { ws = getComputedStyle(el).whiteSpace || ""; } catch (e) {}
    return /^(pre|pre-wrap|pre-line|break-spaces)$/.test(ws);
  };
  var safely = function (fn, fallback) { try { return fn(); } catch (e) { if (e && typeof e === "object" && e.name === "SecurityError") throw e; return fallback; } };
  var methods = {
    execCommand: function execCommand(command, showUI, value) {
      if (arguments.length < 1) throw new TypeError("Document.execCommand: At least 1 argument required");
      command = String(command);
      if (!own(this)) return false;
      var lower = command.toLowerCase();
      if (/^(copy|cut|paste)$/.test(lower) && __jb.clipboardCommand) return __jb.clipboardCommand(lower, this) === true;
      var args = arguments.length < 2 ? [command] : arguments.length < 3 ? [command, !!showUI] : [command, !!showUI, String(value)];
      var ph = plaintextHost();
      if (ph) {
        if (!PLAINTEXT_OK[lower] && lower in E.commands) return false;
        if (lower === "insertparagraph") { lower = "insertlinebreak"; args = ["insertlinebreak"]; }
        if (lower === "insertlinebreak" && preservesNewlines(ph)) { args = ["inserttext", false, "\n"]; }
      }
      var range = safely(function () { return E.getActiveRange(); }, null);
      var host = range ? editingHostOf(range.startContainer) : null;
      var before = host ? host.innerHTML : null;
      var ok = safely(function () { return E.exec.apply(null, args); }, false);
      if (ok === true && host && INPUT_TYPES[lower] && host.isConnected) {
        // data: the inserted text, or the value of the color / font commands
        var withValue = /^(inserttext|backcolor|forecolor|hilitecolor|fontname|createlink|insertimage)$/.test(lower);
        var init = { bubbles: true, cancelable: false, inputType: INPUT_TYPES[lower], data: withValue ? (args[2] !== undefined ? args[2] : "") : null, dataTransfer: null };
        var ev = new InputEvent("input", init);
        __jb.setTrusted(ev, true); ev._trustedDispatch = true;
        host.dispatchEvent(ev);
      }
      return ok === true;
    },
    queryCommandEnabled: function queryCommandEnabled(command) {
      if (arguments.length < 1) throw new TypeError("Document.queryCommandEnabled: At least 1 argument required");
      command = String(command);
      if (own(this) && plaintextHost() && !PLAINTEXT_OK[command.toLowerCase()] && command.toLowerCase() in E.commands) return false;
      return own(this) && safely(function () { return E.enabled(command); }, false) === true;
    },
    queryCommandIndeterm: function queryCommandIndeterm(command) {
      if (arguments.length < 1) throw new TypeError("Document.queryCommandIndeterm: At least 1 argument required");
      command = String(command);
      return own(this) && safely(function () { return E.indeterm(command); }, false) === true;
    },
    queryCommandState: function queryCommandState(command) {
      if (arguments.length < 1) throw new TypeError("Document.queryCommandState: At least 1 argument required");
      command = String(command);
      return own(this) && safely(function () { return E.state(command); }, false) === true;
    },
    queryCommandSupported: function queryCommandSupported(command) {
      if (arguments.length < 1) throw new TypeError("Document.queryCommandSupported: At least 1 argument required");
      command = String(command);
      return safely(function () { return E.supported(command); }, false) === true;
    },
    queryCommandValue: function queryCommandValue(command) {
      if (arguments.length < 1) throw new TypeError("Document.queryCommandValue: At least 1 argument required");
      command = String(command);
      if (!own(this)) return "";
      var v = safely(function () { return E.value(command); }, "");
      return v === undefined || v === null ? "" : String(v);
    },
  };
  Object.keys(methods).forEach(function (k) {
    Object.defineProperty(Document.prototype, k, { value: methods[k], writable: true, enumerable: true, configurable: true });
  });
})();
