// Part 5e2: WebGL 1 and 2 contexts without a rasterizer (real pages only). Map and chart libraries
// (Mapbox GL, MapLibre, Google's vector maps, three.js) need a context that initialises: objects keep
// their state, shaders compile and programs link, and introspection answers from the GLSL
// declarations (a light preprocessor and top-level declaration scan). Drawing is a no-op, uploads are
// dropped and reads give zeros, so the canvas stays transparent while the page's DOM (markers,
// popups, lists) is built. The renderer string says so; no GPU is claimed. WPT runs keep
// getContext("webgl") === null and no WebGL interface objects (__jb.wptMode).
(function () {
  function glOn() {
    try { if (__jb.wptMode) return false; var t = typeof __jb.topJb === "function" ? __jb.topJb() : null; return !(t && t.wptMode); } catch (e) { return false; }
  }

  // ------------------------------------------------------------ constants
  var C1 = "DEPTH_BUFFER_BIT 100 STENCIL_BUFFER_BIT 400 COLOR_BUFFER_BIT 4000 POINTS 0 LINES 1 LINE_LOOP 2 LINE_STRIP 3 TRIANGLES 4 TRIANGLE_STRIP 5 TRIANGLE_FAN 6 " +
    "ZERO 0 ONE 1 SRC_COLOR 300 ONE_MINUS_SRC_COLOR 301 SRC_ALPHA 302 ONE_MINUS_SRC_ALPHA 303 DST_ALPHA 304 ONE_MINUS_DST_ALPHA 305 DST_COLOR 306 ONE_MINUS_DST_COLOR 307 SRC_ALPHA_SATURATE 308 " +
    "FUNC_ADD 8006 BLEND_EQUATION 8009 BLEND_EQUATION_RGB 8009 BLEND_EQUATION_ALPHA 883D FUNC_SUBTRACT 800A FUNC_REVERSE_SUBTRACT 800B BLEND_DST_RGB 80C8 BLEND_SRC_RGB 80C9 BLEND_DST_ALPHA 80CA BLEND_SRC_ALPHA 80CB " +
    "CONSTANT_COLOR 8001 ONE_MINUS_CONSTANT_COLOR 8002 CONSTANT_ALPHA 8003 ONE_MINUS_CONSTANT_ALPHA 8004 BLEND_COLOR 8005 ARRAY_BUFFER 8892 ELEMENT_ARRAY_BUFFER 8893 ARRAY_BUFFER_BINDING 8894 ELEMENT_ARRAY_BUFFER_BINDING 8895 " +
    "STREAM_DRAW 88E0 STATIC_DRAW 88E4 DYNAMIC_DRAW 88E8 BUFFER_SIZE 8764 BUFFER_USAGE 8765 CURRENT_VERTEX_ATTRIB 8626 FRONT 404 BACK 405 FRONT_AND_BACK 408 CULL_FACE B44 BLEND BE2 DITHER BD0 STENCIL_TEST B90 DEPTH_TEST B71 SCISSOR_TEST C11 " +
    "POLYGON_OFFSET_FILL 8037 SAMPLE_ALPHA_TO_COVERAGE 809E SAMPLE_COVERAGE 80A0 NO_ERROR 0 INVALID_ENUM 500 INVALID_VALUE 501 INVALID_OPERATION 502 OUT_OF_MEMORY 505 CW 900 CCW 901 LINE_WIDTH B21 " +
    "ALIASED_POINT_SIZE_RANGE 846D ALIASED_LINE_WIDTH_RANGE 846E CULL_FACE_MODE B45 FRONT_FACE B46 DEPTH_RANGE B70 DEPTH_WRITEMASK B72 DEPTH_CLEAR_VALUE B73 DEPTH_FUNC B74 STENCIL_CLEAR_VALUE B91 STENCIL_FUNC B92 STENCIL_FAIL B94 " +
    "STENCIL_PASS_DEPTH_FAIL B95 STENCIL_PASS_DEPTH_PASS B96 STENCIL_REF B97 STENCIL_VALUE_MASK B93 STENCIL_WRITEMASK B98 STENCIL_BACK_FUNC 8800 STENCIL_BACK_FAIL 8801 STENCIL_BACK_PASS_DEPTH_FAIL 8802 STENCIL_BACK_PASS_DEPTH_PASS 8803 " +
    "STENCIL_BACK_REF 8CA3 STENCIL_BACK_VALUE_MASK 8CA4 STENCIL_BACK_WRITEMASK 8CA5 VIEWPORT BA2 SCISSOR_BOX C10 COLOR_CLEAR_VALUE C22 COLOR_WRITEMASK C23 UNPACK_ALIGNMENT CF5 PACK_ALIGNMENT D05 MAX_TEXTURE_SIZE D33 MAX_VIEWPORT_DIMS D3A " +
    "SUBPIXEL_BITS D50 RED_BITS D52 GREEN_BITS D53 BLUE_BITS D54 ALPHA_BITS D55 DEPTH_BITS D56 STENCIL_BITS D57 POLYGON_OFFSET_UNITS 2A00 POLYGON_OFFSET_FACTOR 8038 TEXTURE_BINDING_2D 8069 SAMPLE_BUFFERS 80A8 SAMPLES 80A9 " +
    "SAMPLE_COVERAGE_VALUE 80AA SAMPLE_COVERAGE_INVERT 80AB COMPRESSED_TEXTURE_FORMATS 86A3 DONT_CARE 1100 FASTEST 1101 NICEST 1102 GENERATE_MIPMAP_HINT 8192 BYTE 1400 UNSIGNED_BYTE 1401 SHORT 1402 UNSIGNED_SHORT 1403 INT 1404 " +
    "UNSIGNED_INT 1405 FLOAT 1406 DEPTH_COMPONENT 1902 ALPHA 1906 RGB 1907 RGBA 1908 LUMINANCE 1909 LUMINANCE_ALPHA 190A UNSIGNED_SHORT_4_4_4_4 8033 UNSIGNED_SHORT_5_5_5_1 8034 UNSIGNED_SHORT_5_6_5 8363 " +
    "FRAGMENT_SHADER 8B30 VERTEX_SHADER 8B31 MAX_VERTEX_ATTRIBS 8869 MAX_VERTEX_UNIFORM_VECTORS 8DFB MAX_VARYING_VECTORS 8DFC MAX_COMBINED_TEXTURE_IMAGE_UNITS 8B4D MAX_VERTEX_TEXTURE_IMAGE_UNITS 8B4C MAX_TEXTURE_IMAGE_UNITS 8872 " +
    "MAX_FRAGMENT_UNIFORM_VECTORS 8DFD SHADER_TYPE 8B4F DELETE_STATUS 8B80 LINK_STATUS 8B82 VALIDATE_STATUS 8B83 ATTACHED_SHADERS 8B85 ACTIVE_UNIFORMS 8B86 ACTIVE_ATTRIBUTES 8B89 SHADING_LANGUAGE_VERSION 8B8C CURRENT_PROGRAM 8B8D " +
    "NEVER 200 LESS 201 EQUAL 202 LEQUAL 203 GREATER 204 NOTEQUAL 205 GEQUAL 206 ALWAYS 207 KEEP 1E00 REPLACE 1E01 INCR 1E02 DECR 1E03 INVERT 150A INCR_WRAP 8507 DECR_WRAP 8508 VENDOR 1F00 RENDERER 1F01 VERSION 1F02 " +
    "NEAREST 2600 LINEAR 2601 NEAREST_MIPMAP_NEAREST 2700 LINEAR_MIPMAP_NEAREST 2701 NEAREST_MIPMAP_LINEAR 2702 LINEAR_MIPMAP_LINEAR 2703 TEXTURE_MAG_FILTER 2800 TEXTURE_MIN_FILTER 2801 TEXTURE_WRAP_S 2802 TEXTURE_WRAP_T 2803 " +
    "TEXTURE_2D DE1 TEXTURE 1702 TEXTURE_CUBE_MAP 8513 TEXTURE_BINDING_CUBE_MAP 8514 TEXTURE_CUBE_MAP_POSITIVE_X 8515 TEXTURE_CUBE_MAP_NEGATIVE_X 8516 TEXTURE_CUBE_MAP_POSITIVE_Y 8517 TEXTURE_CUBE_MAP_NEGATIVE_Y 8518 " +
    "TEXTURE_CUBE_MAP_POSITIVE_Z 8519 TEXTURE_CUBE_MAP_NEGATIVE_Z 851A MAX_CUBE_MAP_TEXTURE_SIZE 851C ACTIVE_TEXTURE 84E0 REPEAT 2901 CLAMP_TO_EDGE 812F MIRRORED_REPEAT 8370 " +
    "FLOAT_VEC2 8B50 FLOAT_VEC3 8B51 FLOAT_VEC4 8B52 INT_VEC2 8B53 INT_VEC3 8B54 INT_VEC4 8B55 BOOL 8B56 BOOL_VEC2 8B57 BOOL_VEC3 8B58 BOOL_VEC4 8B59 FLOAT_MAT2 8B5A FLOAT_MAT3 8B5B FLOAT_MAT4 8B5C SAMPLER_2D 8B5E SAMPLER_CUBE 8B60 " +
    "VERTEX_ATTRIB_ARRAY_ENABLED 8622 VERTEX_ATTRIB_ARRAY_SIZE 8623 VERTEX_ATTRIB_ARRAY_STRIDE 8624 VERTEX_ATTRIB_ARRAY_TYPE 8625 VERTEX_ATTRIB_ARRAY_NORMALIZED 886A VERTEX_ATTRIB_ARRAY_POINTER 8645 VERTEX_ATTRIB_ARRAY_BUFFER_BINDING 889F " +
    "IMPLEMENTATION_COLOR_READ_TYPE 8B9A IMPLEMENTATION_COLOR_READ_FORMAT 8B9B COMPILE_STATUS 8B81 LOW_FLOAT 8DF0 MEDIUM_FLOAT 8DF1 HIGH_FLOAT 8DF2 LOW_INT 8DF3 MEDIUM_INT 8DF4 HIGH_INT 8DF5 FRAMEBUFFER 8D40 RENDERBUFFER 8D41 " +
    "RGBA4 8056 RGB5_A1 8057 RGB565 8D62 DEPTH_COMPONENT16 81A5 STENCIL_INDEX8 8D48 DEPTH_STENCIL 84F9 RENDERBUFFER_WIDTH 8D42 RENDERBUFFER_HEIGHT 8D43 RENDERBUFFER_INTERNAL_FORMAT 8D44 RENDERBUFFER_RED_SIZE 8D50 " +
    "RENDERBUFFER_GREEN_SIZE 8D51 RENDERBUFFER_BLUE_SIZE 8D52 RENDERBUFFER_ALPHA_SIZE 8D53 RENDERBUFFER_DEPTH_SIZE 8D54 RENDERBUFFER_STENCIL_SIZE 8D55 FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE 8CD0 FRAMEBUFFER_ATTACHMENT_OBJECT_NAME 8CD1 " +
    "FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL 8CD2 FRAMEBUFFER_ATTACHMENT_TEXTURE_CUBE_MAP_FACE 8CD3 COLOR_ATTACHMENT0 8CE0 DEPTH_ATTACHMENT 8D00 STENCIL_ATTACHMENT 8D20 DEPTH_STENCIL_ATTACHMENT 821A NONE 0 FRAMEBUFFER_COMPLETE 8CD5 " +
    "FRAMEBUFFER_INCOMPLETE_ATTACHMENT 8CD6 FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT 8CD7 FRAMEBUFFER_INCOMPLETE_DIMENSIONS 8CD9 FRAMEBUFFER_UNSUPPORTED 8CDD FRAMEBUFFER_BINDING 8CA6 RENDERBUFFER_BINDING 8CA7 MAX_RENDERBUFFER_SIZE 84E8 " +
    "INVALID_FRAMEBUFFER_OPERATION 506 UNPACK_FLIP_Y_WEBGL 9240 UNPACK_PREMULTIPLY_ALPHA_WEBGL 9241 CONTEXT_LOST_WEBGL 9242 UNPACK_COLORSPACE_CONVERSION_WEBGL 9243 BROWSER_DEFAULT_WEBGL 9244";
  var C2 = "READ_BUFFER C02 UNPACK_ROW_LENGTH CF2 UNPACK_SKIP_ROWS CF3 UNPACK_SKIP_PIXELS CF4 PACK_ROW_LENGTH D02 PACK_SKIP_ROWS D03 PACK_SKIP_PIXELS D04 COLOR 1800 DEPTH 1801 STENCIL 1802 RED 1903 RGB8 8051 RGBA8 8058 RGB10_A2 8059 " +
    "TEXTURE_BINDING_3D 806A UNPACK_SKIP_IMAGES 806D UNPACK_IMAGE_HEIGHT 806E TEXTURE_3D 806F TEXTURE_WRAP_R 8072 MAX_3D_TEXTURE_SIZE 8073 UNSIGNED_INT_2_10_10_10_REV 8368 MAX_ELEMENTS_VERTICES 80E8 MAX_ELEMENTS_INDICES 80E9 " +
    "TEXTURE_MIN_LOD 813A TEXTURE_MAX_LOD 813B TEXTURE_BASE_LEVEL 813C TEXTURE_MAX_LEVEL 813D MIN 8007 MAX 8008 DEPTH_COMPONENT24 81A6 MAX_TEXTURE_LOD_BIAS 84FD TEXTURE_COMPARE_MODE 884C TEXTURE_COMPARE_FUNC 884D CURRENT_QUERY 8865 " +
    "QUERY_RESULT 8866 QUERY_RESULT_AVAILABLE 8867 STREAM_READ 88E1 STREAM_COPY 88E2 STATIC_READ 88E5 STATIC_COPY 88E6 DYNAMIC_READ 88E9 DYNAMIC_COPY 88EA MAX_DRAW_BUFFERS 8824 MAX_FRAGMENT_UNIFORM_COMPONENTS 8B49 " +
    "MAX_VERTEX_UNIFORM_COMPONENTS 8B4A SAMPLER_3D 8B5F SAMPLER_2D_SHADOW 8B62 FRAGMENT_SHADER_DERIVATIVE_HINT 8B8B PIXEL_PACK_BUFFER 88EB PIXEL_UNPACK_BUFFER 88EC PIXEL_PACK_BUFFER_BINDING 88ED PIXEL_UNPACK_BUFFER_BINDING 88EF " +
    "FLOAT_MAT2x3 8B65 FLOAT_MAT2x4 8B66 FLOAT_MAT3x2 8B67 FLOAT_MAT3x4 8B68 FLOAT_MAT4x2 8B69 FLOAT_MAT4x3 8B6A SRGB 8C40 SRGB8 8C41 SRGB8_ALPHA8 8C43 COMPARE_REF_TO_TEXTURE 884E RGBA32F 8814 RGB32F 8815 RGBA16F 881A RGB16F 881B " +
    "VERTEX_ATTRIB_ARRAY_INTEGER 88FD MAX_ARRAY_TEXTURE_LAYERS 88FF MIN_PROGRAM_TEXEL_OFFSET 8904 MAX_PROGRAM_TEXEL_OFFSET 8905 MAX_VARYING_COMPONENTS 8B4B TEXTURE_2D_ARRAY 8C1A TEXTURE_BINDING_2D_ARRAY 8C1D " +
    "R11F_G11F_B10F 8C3A UNSIGNED_INT_10F_11F_11F_REV 8C3B RGB9_E5 8C3D UNSIGNED_INT_5_9_9_9_REV 8C3E TRANSFORM_FEEDBACK_BUFFER_MODE 8C7F MAX_TRANSFORM_FEEDBACK_SEPARATE_COMPONENTS 8C80 TRANSFORM_FEEDBACK_VARYINGS 8C83 " +
    "TRANSFORM_FEEDBACK_BUFFER_START 8C84 TRANSFORM_FEEDBACK_BUFFER_SIZE 8C85 TRANSFORM_FEEDBACK_PRIMITIVES_WRITTEN 8C88 RASTERIZER_DISCARD 8C89 MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS 8C8A MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS 8C8B " +
    "INTERLEAVED_ATTRIBS 8C8C SEPARATE_ATTRIBS 8C8D TRANSFORM_FEEDBACK_BUFFER 8C8E TRANSFORM_FEEDBACK_BUFFER_BINDING 8C8F RGBA32UI 8D70 RGB32UI 8D71 RGBA16UI 8D76 RGB16UI 8D77 RGBA8UI 8D7C RGB8UI 8D7D RGBA32I 8D82 RGB32I 8D83 " +
    "RGBA16I 8D88 RGB16I 8D89 RGBA8I 8D8E RGB8I 8D8F RED_INTEGER 8D94 RGB_INTEGER 8D98 RGBA_INTEGER 8D99 SAMPLER_2D_ARRAY 8DC1 SAMPLER_2D_ARRAY_SHADOW 8DC4 SAMPLER_CUBE_SHADOW 8DC5 UNSIGNED_INT_VEC2 8DC6 UNSIGNED_INT_VEC3 8DC7 " +
    "UNSIGNED_INT_VEC4 8DC8 INT_SAMPLER_2D 8DCA INT_SAMPLER_3D 8DCB INT_SAMPLER_CUBE 8DCC INT_SAMPLER_2D_ARRAY 8DCF UNSIGNED_INT_SAMPLER_2D 8DD2 UNSIGNED_INT_SAMPLER_3D 8DD3 UNSIGNED_INT_SAMPLER_CUBE 8DD4 UNSIGNED_INT_SAMPLER_2D_ARRAY 8DD7 " +
    "DEPTH_COMPONENT32F 8CAC DEPTH32F_STENCIL8 8CAD FLOAT_32_UNSIGNED_INT_24_8_REV 8DAD FRAMEBUFFER_ATTACHMENT_COLOR_ENCODING 8210 FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE 8211 FRAMEBUFFER_ATTACHMENT_RED_SIZE 8212 " +
    "FRAMEBUFFER_ATTACHMENT_GREEN_SIZE 8213 FRAMEBUFFER_ATTACHMENT_BLUE_SIZE 8214 FRAMEBUFFER_ATTACHMENT_ALPHA_SIZE 8215 FRAMEBUFFER_ATTACHMENT_DEPTH_SIZE 8216 FRAMEBUFFER_ATTACHMENT_STENCIL_SIZE 8217 FRAMEBUFFER_DEFAULT 8218 " +
    "UNSIGNED_INT_24_8 84FA DEPTH24_STENCIL8 88F0 UNSIGNED_NORMALIZED 8C17 DRAW_FRAMEBUFFER_BINDING 8CA6 READ_FRAMEBUFFER 8CA8 DRAW_FRAMEBUFFER 8CA9 READ_FRAMEBUFFER_BINDING 8CAA RENDERBUFFER_SAMPLES 8CAB " +
    "FRAMEBUFFER_ATTACHMENT_TEXTURE_LAYER 8CD4 MAX_COLOR_ATTACHMENTS 8CDF FRAMEBUFFER_INCOMPLETE_MULTISAMPLE 8D56 MAX_SAMPLES 8D57 HALF_FLOAT 140B RG 8227 RG_INTEGER 8228 R8 8229 RG8 822B R16F 822D R32F 822E RG16F 822F RG32F 8230 " +
    "R8I 8231 R8UI 8232 R16I 8233 R16UI 8234 R32I 8235 R32UI 8236 RG8I 8237 RG8UI 8238 RG16I 8239 RG16UI 823A RG32I 823B RG32UI 823C VERTEX_ARRAY_BINDING 85B5 R8_SNORM 8F94 RG8_SNORM 8F95 RGB8_SNORM 8F96 RGBA8_SNORM 8F97 " +
    "SIGNED_NORMALIZED 8F9C COPY_READ_BUFFER 8F36 COPY_WRITE_BUFFER 8F37 COPY_READ_BUFFER_BINDING 8F36 COPY_WRITE_BUFFER_BINDING 8F37 UNIFORM_BUFFER 8A11 UNIFORM_BUFFER_BINDING 8A28 UNIFORM_BUFFER_START 8A29 UNIFORM_BUFFER_SIZE 8A2A " +
    "MAX_VERTEX_UNIFORM_BLOCKS 8A2B MAX_FRAGMENT_UNIFORM_BLOCKS 8A2D MAX_COMBINED_UNIFORM_BLOCKS 8A2E MAX_UNIFORM_BUFFER_BINDINGS 8A2F MAX_UNIFORM_BLOCK_SIZE 8A30 MAX_COMBINED_VERTEX_UNIFORM_COMPONENTS 8A31 " +
    "MAX_COMBINED_FRAGMENT_UNIFORM_COMPONENTS 8A33 UNIFORM_BUFFER_OFFSET_ALIGNMENT 8A34 ACTIVE_UNIFORM_BLOCKS 8A36 UNIFORM_TYPE 8A37 UNIFORM_SIZE 8A38 UNIFORM_BLOCK_INDEX 8A3A UNIFORM_OFFSET 8A3B UNIFORM_ARRAY_STRIDE 8A3C " +
    "UNIFORM_MATRIX_STRIDE 8A3D UNIFORM_IS_ROW_MAJOR 8A3E UNIFORM_BLOCK_BINDING 8A3F UNIFORM_BLOCK_DATA_SIZE 8A40 UNIFORM_BLOCK_ACTIVE_UNIFORMS 8A42 UNIFORM_BLOCK_ACTIVE_UNIFORM_INDICES 8A43 " +
    "UNIFORM_BLOCK_REFERENCED_BY_VERTEX_SHADER 8A44 UNIFORM_BLOCK_REFERENCED_BY_FRAGMENT_SHADER 8A46 INVALID_INDEX FFFFFFFF MAX_VERTEX_OUTPUT_COMPONENTS 9122 MAX_FRAGMENT_INPUT_COMPONENTS 9125 MAX_SERVER_WAIT_TIMEOUT 9111 " +
    "OBJECT_TYPE 9112 SYNC_CONDITION 9113 SYNC_STATUS 9114 SYNC_FLAGS 9115 SYNC_FENCE 9116 SYNC_GPU_COMMANDS_COMPLETE 9117 UNSIGNALED 9118 SIGNALED 9119 ALREADY_SIGNALED 911A TIMEOUT_EXPIRED 911B CONDITION_SATISFIED 911C " +
    "WAIT_FAILED 911D SYNC_FLUSH_COMMANDS_BIT 1 VERTEX_ATTRIB_ARRAY_DIVISOR 88FE ANY_SAMPLES_PASSED 8C2F ANY_SAMPLES_PASSED_CONSERVATIVE 8D6A SAMPLER_BINDING 8919 RGB10_A2UI 906F INT_2_10_10_10_REV 8D9F TRANSFORM_FEEDBACK 8E22 " +
    "TRANSFORM_FEEDBACK_PAUSED 8E23 TRANSFORM_FEEDBACK_ACTIVE 8E24 TRANSFORM_FEEDBACK_BINDING 8E25 TEXTURE_IMMUTABLE_FORMAT 912F MAX_ELEMENT_INDEX 8D6B TEXTURE_IMMUTABLE_LEVELS 82DF MAX_CLIENT_WAIT_TIMEOUT_WEBGL 9247";
  function parseConsts(str, out) { var a = str.split(" "); for (var i = 0; i < a.length; i += 2) out[a[i]] = parseInt(a[i + 1], 16); return out; }
  var K1 = parseConsts(C1, {});
  for (var ti = 0; ti < 32; ti++) K1["TEXTURE" + ti] = 0x84C0 + ti;
  var K2 = parseConsts(C2, Object.assign({}, K1));
  for (var di = 0; di < 16; di++) { K2["DRAW_BUFFER" + di] = 0x8825 + di; K2["COLOR_ATTACHMENT" + di] = 0x8CE0 + di; }
  K2.TIMEOUT_IGNORED = -1;
  var G = K2; // enum values used by the implementation

  // ------------------------------------------------------------ GLSL types
  // name -> [enum, components (for getUniform), kind, std140 size, std140 align, matrix columns]
  var TYPES = {
    float: [G.FLOAT, 1, "f", 4, 4, 0], vec2: [G.FLOAT_VEC2, 2, "f", 8, 8, 0], vec3: [G.FLOAT_VEC3, 3, "f", 12, 16, 0], vec4: [G.FLOAT_VEC4, 4, "f", 16, 16, 0],
    int: [G.INT, 1, "i", 4, 4, 0], ivec2: [G.INT_VEC2, 2, "i", 8, 8, 0], ivec3: [G.INT_VEC3, 3, "i", 12, 16, 0], ivec4: [G.INT_VEC4, 4, "i", 16, 16, 0],
    uint: [G.UNSIGNED_INT, 1, "u", 4, 4, 0], uvec2: [G.UNSIGNED_INT_VEC2, 2, "u", 8, 8, 0], uvec3: [G.UNSIGNED_INT_VEC3, 3, "u", 12, 16, 0], uvec4: [G.UNSIGNED_INT_VEC4, 4, "u", 16, 16, 0],
    bool: [G.BOOL, 1, "b", 4, 4, 0], bvec2: [G.BOOL_VEC2, 2, "b", 8, 8, 0], bvec3: [G.BOOL_VEC3, 3, "b", 12, 16, 0], bvec4: [G.BOOL_VEC4, 4, "b", 16, 16, 0],
    mat2: [G.FLOAT_MAT2, 4, "f", 32, 16, 2], mat3: [G.FLOAT_MAT3, 9, "f", 48, 16, 3], mat4: [G.FLOAT_MAT4, 16, "f", 64, 16, 4],
    mat2x2: [G.FLOAT_MAT2, 4, "f", 32, 16, 2], mat3x3: [G.FLOAT_MAT3, 9, "f", 48, 16, 3], mat4x4: [G.FLOAT_MAT4, 16, "f", 64, 16, 4],
    mat2x3: [G.FLOAT_MAT2x3, 6, "f", 32, 16, 2], mat2x4: [G.FLOAT_MAT2x4, 8, "f", 32, 16, 2], mat3x2: [G.FLOAT_MAT3x2, 6, "f", 48, 16, 3],
    mat3x4: [G.FLOAT_MAT3x4, 12, "f", 48, 16, 3], mat4x2: [G.FLOAT_MAT4x2, 8, "f", 64, 16, 4], mat4x3: [G.FLOAT_MAT4x3, 12, "f", 64, 16, 4],
    sampler2D: [G.SAMPLER_2D, 1, "s"], samplerCube: [G.SAMPLER_CUBE, 1, "s"], sampler3D: [G.SAMPLER_3D, 1, "s"], sampler2DShadow: [G.SAMPLER_2D_SHADOW, 1, "s"],
    sampler2DArray: [G.SAMPLER_2D_ARRAY, 1, "s"], sampler2DArrayShadow: [G.SAMPLER_2D_ARRAY_SHADOW, 1, "s"], samplerCubeShadow: [G.SAMPLER_CUBE_SHADOW, 1, "s"],
    isampler2D: [G.INT_SAMPLER_2D, 1, "s"], isampler3D: [G.INT_SAMPLER_3D, 1, "s"], isamplerCube: [G.INT_SAMPLER_CUBE, 1, "s"], isampler2DArray: [G.INT_SAMPLER_2D_ARRAY, 1, "s"],
    usampler2D: [G.UNSIGNED_INT_SAMPLER_2D, 1, "s"], usampler3D: [G.UNSIGNED_INT_SAMPLER_3D, 1, "s"], usamplerCube: [G.UNSIGNED_INT_SAMPLER_CUBE, 1, "s"], usampler2DArray: [G.UNSIGNED_INT_SAMPLER_2D_ARRAY, 1, "s"],
    samplerExternalOES: [G.SAMPLER_2D, 1, "s"],
  };
  var ATTR_SLOTS = { mat2: 2, mat3: 3, mat4: 4, mat2x2: 2, mat3x3: 3, mat4x4: 4, mat2x3: 2, mat2x4: 2, mat3x2: 3, mat3x4: 3, mat4x2: 4, mat4x3: 4 };
  var PREC = /^(highp|mediump|lowp|flat|smooth|centroid|invariant|const)$/;

  // ------------------------------------------------------------ GLSL scan
  // Preprocess: comments, line continuations, #define/#undef/#if*/#else/#elif/#endif; object-like
  // macros are expanded in the kept lines (array sizes such as u_arr[MAX_LIGHTS]).
  function evalCond(expr, macros) {
    expr = expr.replace(/\bdefined\s*\(\s*(\w+)\s*\)|\bdefined\s+(\w+)/g, function (m, a, b) { return (a || b) in macros ? "1" : "0"; });
    for (var pass = 0; pass < 4; pass++) expr = expr.replace(/[A-Za-z_]\w*/g, function (id) { return id in macros && macros[id] !== null ? "(" + (macros[id] || "0") + ")" : id; });
    expr = expr.replace(/[A-Za-z_]\w*/g, "0").replace(/(\d+(?:\.\d*)?)[uUfF]\b/g, "$1");
    if (!/^[\s\d.()!&|<>=+\-*\/%^~?:xXa-fA-F]*$/.test(expr)) return false;
    try { return !!Function("return (" + (expr.trim() || "0") + ");")(); } catch (e) { return false; }
  }
  function expandMacros(line, macros) {
    for (var pass = 0; pass < 4; pass++) {
      var changed = false;
      line = line.replace(/[A-Za-z_]\w*/g, function (id) { if (Object.prototype.hasOwnProperty.call(macros, id) && macros[id] !== null && macros[id] !== id) { changed = true; return macros[id]; } return id; });
      if (!changed) break;
    }
    return line;
  }
  function preprocess(src, kind) {
    src = String(src).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, "").replace(/\\\r?\n/g, "");
    var version = /^\s*#\s*version\s+300/m.test(src) ? 300 : 100;
    var macros = Object.create(null);
    macros.GL_ES = "1"; macros.__VERSION__ = String(version); macros.GL_FRAGMENT_PRECISION_HIGH = "1";
    ["GL_OES_standard_derivatives", "GL_EXT_frag_depth", "GL_EXT_shader_texture_lod", "GL_EXT_draw_buffers"].forEach(function (m) { macros[m] = "1"; });
    var lines = src.split(/\r?\n/), out = [], stack = []; // stack entries: {on, taken, parentOn}
    var active = function () { return stack.length === 0 || stack[stack.length - 1].on; };
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i], m = /^\s*#\s*(\w+)\s*(.*)$/.exec(ln);
      if (!m) { if (active()) out.push(expandMacros(ln, macros)); continue; }
      var dir = m[1], rest = m[2].trim(), parentOn = active();
      if (dir === "ifdef" || dir === "ifndef") { var d = (rest.split(/\s+/)[0] in macros); var on = parentOn && (dir === "ifdef" ? d : !d); stack.push({ on: on, taken: on, parentOn: parentOn }); }
      else if (dir === "if") { var c = parentOn && evalCond(rest, macros); stack.push({ on: c, taken: c, parentOn: parentOn }); }
      else if (dir === "elif") { var top = stack[stack.length - 1]; if (top) { var e = top.parentOn && !top.taken && evalCond(rest, macros); top.on = e; if (e) top.taken = true; } }
      else if (dir === "else") { var t2 = stack[stack.length - 1]; if (t2) { t2.on = t2.parentOn && !t2.taken; t2.taken = true; } }
      else if (dir === "endif") stack.pop();
      else if (!parentOn) continue;
      else if (dir === "define") { var dm = /^(\w+)(\([^)]*\))?\s*(.*)$/.exec(rest); if (dm) macros[dm[1]] = dm[2] ? null : dm[3].trim(); }
      else if (dir === "undef") delete macros[rest.split(/\s+/)[0]];
    }
    return { code: out.join("\n"), version: version, kind: kind };
  }
  function arraySize(expr) {
    expr = String(expr).replace(/(\d+)[uU]/g, "$1").trim();
    if (!expr || !/^[\s\d()+\-*\/%<>]*$/.test(expr)) return 1;
    var v = 1;
    try { v = Math.floor(Number(Function("return (" + expr + ");")())); } catch (e) { v = 1; }
    return v > 0 && v < 65536 ? v : 1;
  }
  // split "a, b[3], c[N + 1]" declarators -> [{name, array}]
  function declarators(s) {
    var out = [], depth = 0, cur = "";
    for (var i = 0; i < s.length; i++) { var ch = s[i]; if (ch === "[" || ch === "(") depth++; if (ch === "]" || ch === ")") depth--; if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch; }
    out.push(cur);
    return out.map(function (d) { d = d.split("=")[0]; var m = /^\s*(\w+)\s*(?:\[([^\]]*)\])?/.exec(d); return m ? { name: m[1], array: m[2] !== undefined ? arraySize(m[2]) : 0 } : null; }).filter(Boolean);
  }
  // fields of a struct / block body "vec3 a; float b[2];"
  function fields(body) {
    var out = [];
    body.split(";").forEach(function (st) {
      var toks = st.replace(/\blayout\s*\([^)]*\)/g, " ").trim();
      if (!toks) return;
      var m = /^((?:\w+\s+)*?)(\w+)\s*(?:\[([^\]]*)\])?\s+([\s\S]+)$/.exec(toks);
      if (!m) return;
      var typeArr = m[3] !== undefined ? arraySize(m[3]) : 0;
      declarators(m[4]).forEach(function (d) { out.push({ type: m[2], name: d.name, array: d.array || typeArr }); });
    });
    return out;
  }
  // Top-level declarations of a preprocessed shader.
  function scan(pp) {
    var code = pp.code, res = { uniforms: [], attribs: [], blocks: [], structs: Object.create(null), outs: [] };
    var i = 0, n = code.length, stmt = "";
    var takeBody = function (start) { var depth = 0; for (var j = start; j < n; j++) { if (code[j] === "{") depth++; else if (code[j] === "}") { depth--; if (depth === 0) return j; } } return n - 1; };
    var handleStmt = function (s) {
      s = s.replace(/\s+/g, " ").trim();
      if (!s) return;
      var loc = null, lm = /\blayout\s*\(([^)]*)\)/.exec(s);
      if (lm) { var lv = /\blocation\s*=\s*(\d+)/.exec(lm[1]); if (lv) loc = +lv[1]; s = s.replace(/\blayout\s*\([^)]*\)/g, " ").trim(); }
      var words = s.split(" "), q = [];
      while (words.length && /^(uniform|attribute|in|out|varying|highp|mediump|lowp|flat|smooth|centroid|invariant|const|precise)$/.test(words[0])) q.push(words.shift());
      if (!words.length) return;
      var type = words.shift(), rest = words.join(" ");
      var tm = /^(\w+)\s*\[([^\]]*)\]$/.exec(type), typeArr = 0;
      if (tm) { type = tm[1]; typeArr = arraySize(tm[2]); }
      if (q.indexOf("uniform") >= 0) declarators(rest).forEach(function (d) { res.uniforms.push({ type: type, name: d.name, array: d.array || typeArr }); });
      else if (pp.kind === G.VERTEX_SHADER && (q.indexOf("attribute") >= 0 || (pp.version === 300 && q.indexOf("in") >= 0))) declarators(rest).forEach(function (d) { res.attribs.push({ type: type, name: d.name, array: d.array, loc: loc }); });
      else if (pp.kind === G.FRAGMENT_SHADER && pp.version === 300 && q.indexOf("out") >= 0) declarators(rest).forEach(function (d) { res.outs.push({ name: d.name, loc: loc === null ? 0 : loc }); });
      else if (pp.kind === G.VERTEX_SHADER && q.indexOf("out") >= 0 || q.indexOf("varying") >= 0) declarators(rest).forEach(function (d) { res.outs.push({ name: d.name, type: type, array: d.array }); });
    };
    while (i < n) {
      var ch = code[i];
      if (ch === ";") { handleStmt(stmt); stmt = ""; i++; continue; }
      if (ch === "{") {
        var end = takeBody(i), body = code.slice(i + 1, end), head = stmt.replace(/\blayout\s*\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
        var sm = /(?:^|\s)struct\s+(\w+)$/.exec(head) || /(?:^|\s)struct$/.exec(head) && [head, "__anon" + i];
        var bm = /^(?:(?:highp|mediump|lowp)\s+)?uniform\s+(\w+)$/.exec(head);
        if (sm || bm) {
          // the declarators after the closing brace, up to ';'
          var semi = code.indexOf(";", end); if (semi < 0) semi = n;
          var after = code.slice(end + 1, semi).trim();
          if (sm) {
            res.structs[sm[1]] = fields(body);
            var uq = /\buniform\b/.test(head);
            if (after && uq) declarators(after).forEach(function (d) { res.uniforms.push({ type: sm[1], name: d.name, array: d.array }); });
          } else {
            var inst = after ? declarators(after)[0] : null;
            res.blocks.push({ name: bm[1], fields: fields(body), instance: inst ? inst.name : null, array: inst ? inst.array : 0 });
          }
          i = semi + 1; stmt = ""; continue;
        }
        // a function body (or other braces): skipped
        i = end + 1; stmt = ""; continue;
      }
      stmt += ch; i++;
    }
    return res;
  }

  // Flatten a uniform declaration into active-uniform entries (structs expanded).
  function flattenUniform(name, type, array, structs, out, block) {
    var t = TYPES[type];
    if (t) { out.push({ name: array ? name + "[0]" : name, base: name, size: array || 1, type: t[0], tname: type, block: block === undefined ? -1 : block }); return; }
    var st = structs[type];
    if (!st) return;
    var count = array || 0;
    for (var k = 0; k < (count || 1); k++) {
      var prefix = count ? name + "[" + k + "]" : name;
      st.forEach(function (f) { flattenUniform(prefix + "." + f.name, f.type, f.array, structs, out, block); });
    }
  }
  // std140 layout of a block's members (offsets, strides) and its data size.
  function std140(fieldsList, structs, prefix, entries, blockIndex, base) {
    var off = base || 0;
    var align = function (v, a) { return Math.ceil(v / a) * a; };
    fieldsList.forEach(function (f) {
      var t = TYPES[f.type];
      if (t && t[3]) {
        var isMat = t[5] > 0, baseAlign = f.array ? 16 : t[4];
        off = align(off, baseAlign);
        var stride = f.array ? align(t[3], 16) : 0;
        entries.push({ name: prefix + f.name + (f.array ? "[0]" : ""), base: prefix + f.name, size: f.array || 1, type: t[0], tname: f.type, block: blockIndex, offset: off, arrayStride: stride, matrixStride: isMat ? 16 : 0 });
        off += f.array ? stride * f.array : t[3];
      } else if (structs[f.type]) {
        off = align(off, 16);
        for (var k = 0; k < (f.array || 1); k++) {
          var start = off;
          off = std140(structs[f.type], structs, prefix + f.name + (f.array ? "[" + k + "]" : "") + ".", entries, blockIndex, off);
          off = align(Math.max(off, start), 16);
        }
      }
    });
    return Math.max(off, base || 0);
  }

  // ------------------------------------------------------------ object types
  function illegal() { throw new TypeError("Illegal constructor"); }
  function defClass(name, parent) {
    var C = { [name]: function () { illegal(); } }[name];
    if (parent) { Object.setPrototypeOf(C.prototype, parent.prototype); Object.setPrototypeOf(C, parent); }
    Object.defineProperty(C.prototype, Symbol.toStringTag, { value: name, configurable: true });
    return C;
  }
  var WebGLObject = defClass("WebGLObject");
  var OBJ = {};
  ["WebGLBuffer", "WebGLFramebuffer", "WebGLProgram", "WebGLRenderbuffer", "WebGLShader", "WebGLTexture", "WebGLQuery", "WebGLSampler", "WebGLSync", "WebGLTransformFeedback", "WebGLVertexArrayObject"].forEach(function (n) { OBJ[n] = defClass(n, WebGLObject); });
  OBJ.WebGLVertexArrayObjectOES = defClass("WebGLVertexArrayObjectOES", WebGLObject);
  OBJ.WebGLTimerQueryEXT = defClass("WebGLTimerQueryEXT", WebGLObject);
  var WebGLUniformLocation = defClass("WebGLUniformLocation");
  var WebGLActiveInfo = defClass("WebGLActiveInfo");
  var WebGLShaderPrecisionFormat = defClass("WebGLShaderPrecisionFormat");
  [["size", "_size"], ["type", "_type"], ["name", "_name"]].forEach(function (p) { Object.defineProperty(WebGLActiveInfo.prototype, p[0], { get: function () { return this[p[1]]; }, configurable: true, enumerable: true }); });
  [["rangeMin", "_min"], ["rangeMax", "_max"], ["precision", "_prec"]].forEach(function (p) { Object.defineProperty(WebGLShaderPrecisionFormat.prototype, p[0], { get: function () { return this[p[1]]; }, configurable: true, enumerable: true }); });
  function hidden(o, k, v) { Object.defineProperty(o, k, { value: v, writable: true, configurable: true }); return o; }
  function mk(cls, ctx, extra) { var o = Object.create(cls.prototype); hidden(o, "_glctx", ctx); hidden(o, "_deleted", false); if (extra) for (var k in extra) hidden(o, k, extra[k]); return o; }
  function activeInfo(e) { var o = Object.create(WebGLActiveInfo.prototype); hidden(o, "_size", e.size); hidden(o, "_type", e.type); hidden(o, "_name", e.name); return o; }

  class WebGLContextEvent extends Event {
    constructor(type, init) {
      if (arguments.length < 1) throw new TypeError("Failed to construct 'WebGLContextEvent': 1 argument required, but only 0 present.");
      super(type, init);
      hidden(this, "_statusMessage", init && init.statusMessage !== undefined ? String(init.statusMessage) : "");
    }
    get statusMessage() { return this._statusMessage; }
  }

  // ------------------------------------------------------------ extensions
  var EXT1 = ["ANGLE_instanced_arrays", "EXT_blend_minmax", "EXT_color_buffer_half_float", "EXT_float_blend", "EXT_frag_depth", "EXT_shader_texture_lod", "EXT_sRGB", "EXT_texture_filter_anisotropic",
    "KHR_parallel_shader_compile", "OES_element_index_uint", "OES_fbo_render_mipmap", "OES_standard_derivatives", "OES_texture_float", "OES_texture_float_linear", "OES_texture_half_float", "OES_texture_half_float_linear",
    "OES_vertex_array_object", "WEBGL_color_buffer_float", "WEBGL_debug_renderer_info", "WEBGL_depth_texture", "WEBGL_draw_buffers", "WEBGL_lose_context"];
  var EXT2 = ["EXT_color_buffer_float", "EXT_color_buffer_half_float", "EXT_float_blend", "EXT_texture_filter_anisotropic", "KHR_parallel_shader_compile", "OES_draw_buffers_indexed", "OES_texture_float_linear", "WEBGL_debug_renderer_info", "WEBGL_lose_context"];
  var EXT_CONST = {
    ANGLE_instanced_arrays: { VERTEX_ATTRIB_ARRAY_DIVISOR_ANGLE: 0x88FE },
    EXT_blend_minmax: { MIN_EXT: 0x8007, MAX_EXT: 0x8008 },
    EXT_color_buffer_half_float: { RGBA16F_EXT: 0x881A, RGB16F_EXT: 0x881B, FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE_EXT: 0x8211, UNSIGNED_NORMALIZED_EXT: 0x8C17 },
    WEBGL_color_buffer_float: { RGBA32F_EXT: 0x8814, FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE_EXT: 0x8211, UNSIGNED_NORMALIZED_EXT: 0x8C17 },
    EXT_sRGB: { SRGB_EXT: 0x8C40, SRGB_ALPHA_EXT: 0x8C42, SRGB8_ALPHA8_EXT: 0x8C43, FRAMEBUFFER_ATTACHMENT_COLOR_ENCODING_EXT: 0x8210 },
    EXT_texture_filter_anisotropic: { TEXTURE_MAX_ANISOTROPY_EXT: 0x84FE, MAX_TEXTURE_MAX_ANISOTROPY_EXT: 0x84FF },
    KHR_parallel_shader_compile: { COMPLETION_STATUS_KHR: 0x91B1 },
    OES_standard_derivatives: { FRAGMENT_SHADER_DERIVATIVE_HINT_OES: 0x8B8B },
    OES_texture_half_float: { HALF_FLOAT_OES: 0x8D61 },
    OES_vertex_array_object: { VERTEX_ARRAY_BINDING_OES: 0x85B5 },
    WEBGL_debug_renderer_info: { UNMASKED_VENDOR_WEBGL: 0x9245, UNMASKED_RENDERER_WEBGL: 0x9246 },
    WEBGL_depth_texture: { UNSIGNED_INT_24_8_WEBGL: 0x84FA },
    WEBGL_draw_buffers: (function () { var o = { MAX_COLOR_ATTACHMENTS_WEBGL: 0x8CDF, MAX_DRAW_BUFFERS_WEBGL: 0x8824 }; for (var i = 0; i < 16; i++) { o["COLOR_ATTACHMENT" + i + "_WEBGL"] = 0x8CE0 + i; o["DRAW_BUFFER" + i + "_WEBGL"] = 0x8825 + i; } return o; })(),
  };
  var VENDOR = "julia-browser", RENDERER = "julia-browser software (no GPU)";

  function makeExtension(ctx, name) {
    var proto = Object.create(Object.prototype);
    Object.defineProperty(proto, Symbol.toStringTag, { value: name, configurable: true });
    var ext = Object.create(proto), consts = EXT_CONST[name] || {};
    for (var k in consts) Object.defineProperty(proto, k, { value: consts[k], enumerable: true });
    var s = ctx._gls, noop = function () {};
    if (name === "ANGLE_instanced_arrays") {
      proto.drawArraysInstancedANGLE = noop; proto.drawElementsInstancedANGLE = noop;
      proto.vertexAttribDivisorANGLE = function (i, d) { ctx.vertexAttribDivisor ? ctx.vertexAttribDivisor(i, d) : impl.vertexAttribDivisor.call(ctx, i, d); };
    } else if (name === "OES_vertex_array_object") {
      proto.createVertexArrayOES = function () { return s.lost ? null : newVao(ctx, OBJ.WebGLVertexArrayObjectOES); };
      proto.deleteVertexArrayOES = function (v) { impl.deleteVertexArray.call(ctx, v); };
      proto.isVertexArrayOES = function (v) { return !!(v && v._glctx === ctx && !v._deleted && v._bound); };
      proto.bindVertexArrayOES = function (v) { impl.bindVertexArray.call(ctx, v); };
    } else if (name === "WEBGL_lose_context") {
      proto.loseContext = function () { loseContext(ctx, true); };
      proto.restoreContext = function () { restoreContext(ctx); };
    } else if (name === "WEBGL_draw_buffers") {
      proto.drawBuffersWEBGL = function (b) { s.drawBuffers = Array.from(b || []); };
    } else if (name === "OES_draw_buffers_indexed") {
      ["enableiOES", "disableiOES", "blendEquationiOES", "blendEquationSeparateiOES", "blendFunciOES", "blendFuncSeparateiOES", "colorMaskiOES"].forEach(function (m) { proto[m] = noop; });
    }
    return ext;
  }

  // ------------------------------------------------------------ context state
  function newVao(ctx, cls) {
    var s = ctx._gls, attrs = [];
    for (var i = 0; i < 16; i++) attrs.push({ enabled: false, size: 4, type: G.FLOAT, normalized: false, stride: 0, offset: 0, buffer: null, divisor: 0, integer: false });
    return mk(cls || OBJ.WebGLVertexArrayObject, ctx, { _attrs: attrs, _elements: null, _bound: false });
  }
  function initState(ctx, version, attrs, canvas) {
    var s = {
      version: version, canvas: canvas, attrs: attrs, lost: false, lostByExt: false, lostPrevented: false, errorLost: false,
      exts: Object.create(null), program: null, activeUnit: 0, units: [], buffers: Object.create(null), indexed: Object.create(null),
      fb: { draw: null, read: null }, rb: null, tf: null, queries: Object.create(null), caps: Object.create(null), st: Object.create(null),
      current: [], drawBuffers: [G.BACK], readBuffer: G.BACK, colorSpace: "srgb", unpackColorSpace: "srgb",
    };
    for (var u = 0; u < 32; u++) s.units.push({ t2d: null, cube: null, t3d: null, t2da: null, sampler: null });
    for (var a = 0; a < 16; a++) s.current.push(new Float32Array([0, 0, 0, 1]));
    var st = s.st;
    st[G.BLEND_COLOR] = [0, 0, 0, 0]; st[G.BLEND_EQUATION_RGB] = G.FUNC_ADD; st[G.BLEND_EQUATION_ALPHA] = G.FUNC_ADD;
    st[G.BLEND_SRC_RGB] = G.ONE; st[G.BLEND_SRC_ALPHA] = G.ONE; st[G.BLEND_DST_RGB] = G.ZERO; st[G.BLEND_DST_ALPHA] = G.ZERO;
    st[G.COLOR_CLEAR_VALUE] = [0, 0, 0, 0]; st[G.COLOR_WRITEMASK] = [true, true, true, true]; st[G.DEPTH_CLEAR_VALUE] = 1; st[G.DEPTH_FUNC] = G.LESS;
    st[G.DEPTH_RANGE] = [0, 1]; st[G.DEPTH_WRITEMASK] = true; st[G.CULL_FACE_MODE] = G.BACK; st[G.FRONT_FACE] = G.CCW; st[G.LINE_WIDTH] = 1;
    st[G.POLYGON_OFFSET_FACTOR] = 0; st[G.POLYGON_OFFSET_UNITS] = 0; st[G.SAMPLE_COVERAGE_VALUE] = 1; st[G.SAMPLE_COVERAGE_INVERT] = false;
    st[G.STENCIL_CLEAR_VALUE] = 0;
    [[G.STENCIL_FUNC, G.ALWAYS], [G.STENCIL_REF, 0], [G.STENCIL_VALUE_MASK, 0x7FFFFFFF], [G.STENCIL_WRITEMASK, 0x7FFFFFFF], [G.STENCIL_FAIL, G.KEEP], [G.STENCIL_PASS_DEPTH_FAIL, G.KEEP], [G.STENCIL_PASS_DEPTH_PASS, G.KEEP],
      [G.STENCIL_BACK_FUNC, G.ALWAYS], [G.STENCIL_BACK_REF, 0], [G.STENCIL_BACK_VALUE_MASK, 0x7FFFFFFF], [G.STENCIL_BACK_WRITEMASK, 0x7FFFFFFF], [G.STENCIL_BACK_FAIL, G.KEEP], [G.STENCIL_BACK_PASS_DEPTH_FAIL, G.KEEP], [G.STENCIL_BACK_PASS_DEPTH_PASS, G.KEEP]].forEach(function (p) { st[p[0]] = p[1]; });
    [[G.UNPACK_ALIGNMENT, 4], [G.PACK_ALIGNMENT, 4], [G.UNPACK_FLIP_Y_WEBGL, false], [G.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false], [G.UNPACK_COLORSPACE_CONVERSION_WEBGL, G.BROWSER_DEFAULT_WEBGL],
      [G.UNPACK_ROW_LENGTH, 0], [G.UNPACK_SKIP_ROWS, 0], [G.UNPACK_SKIP_PIXELS, 0], [G.UNPACK_SKIP_IMAGES, 0], [G.UNPACK_IMAGE_HEIGHT, 0], [G.PACK_ROW_LENGTH, 0], [G.PACK_SKIP_ROWS, 0], [G.PACK_SKIP_PIXELS, 0],
      [G.GENERATE_MIPMAP_HINT, G.DONT_CARE], [G.FRAGMENT_SHADER_DERIVATIVE_HINT, G.DONT_CARE]].forEach(function (p) { st[p[0]] = p[1]; });
    s.caps[G.DITHER] = true;
    var size = __jb.canvasSize(canvas);
    st[G.VIEWPORT] = [0, 0, size[0], size[1]]; st[G.SCISSOR_BOX] = [0, 0, size[0], size[1]];
    hidden(ctx, "_gls", s);
    s.defaultVao = newVao(ctx); s.vao = s.defaultVao;
    return s;
  }
  function S(ctx) { var s = ctx && ctx._gls; if (!s) throw new TypeError("Illegal invocation"); return s; }
  function own(ctx, o) { return !!(o && o._glctx === ctx && !o._deleted); }

  function loseContext(ctx, byExt) {
    var s = ctx._gls;
    if (s.lost) return;
    s.lost = true; s.lostByExt = byExt; s.errorLost = true;
    setTimeout(function () {
      var ev = new WebGLContextEvent("webglcontextlost", { cancelable: true, statusMessage: "" });
      try { s.canvas.dispatchEvent(ev); } catch (e) {}
      s.lostPrevented = ev.defaultPrevented;
    }, 0);
  }
  function restoreContext(ctx) {
    var s = ctx._gls;
    if (!s.lost || !s.lostByExt) return;
    setTimeout(function () {
      if (!s.lostPrevented) return;
      var canvas = s.canvas, version = s.version, attrs = s.attrs, exts = s.exts;
      initState(ctx, version, attrs, canvas);
      ctx._gls.exts = exts;
      try { canvas.dispatchEvent(new WebGLContextEvent("webglcontextrestored", { statusMessage: "" })); } catch (e) {}
    }, 0);
  }

  // ------------------------------------------------------------ implementation
  function bufferTargetKey(s, target) {
    if (target === G.ELEMENT_ARRAY_BUFFER) return null; // per VAO
    return target;
  }
  function texSlot(target) {
    if (target === G.TEXTURE_2D) return "t2d";
    if (target === G.TEXTURE_CUBE_MAP || (target >= G.TEXTURE_CUBE_MAP_POSITIVE_X && target <= G.TEXTURE_CUBE_MAP_NEGATIVE_Z)) return "cube";
    if (target === G.TEXTURE_3D) return "t3d";
    if (target === G.TEXTURE_2D_ARRAY) return "t2da";
    return null;
  }
  function boundTex(s, target) { var k = texSlot(target); return k ? s.units[s.activeUnit][k] : null; }
  function boundFb(s, target) { return target === G.READ_FRAMEBUFFER ? s.fb.read : s.fb.draw; }
  function noop() {}
  function linkProgram(ctx, p) {
    var s = ctx._gls, vs = null, fs = null;
    p._shaders.forEach(function (sh) { if (sh._kind === G.VERTEX_SHADER) vs = sh; else fs = sh; });
    p._linkCount = (p._linkCount || 0) + 1;
    if (!vs || !fs) { p._linked = false; p._log = "ERROR: Program must have a vertex and a fragment shader attached"; return; }
    var v = vs._scan || { uniforms: [], attribs: [], blocks: [], structs: {}, outs: [] }, f = fs._scan || { uniforms: [], attribs: [], blocks: [], structs: {}, outs: [] };
    var structs = Object.assign(Object.create(null), f.structs, v.structs);
    var uniforms = [], seen = Object.create(null);
    [v, f].forEach(function (sc) {
      sc.uniforms.forEach(function (u) { if (seen[u.name]) return; seen[u.name] = true; flattenUniform(u.name, u.type, u.array, structs, uniforms); });
    });
    // uniform blocks (WebGL2)
    var blocks = [], bseen = Object.create(null);
    [[v, "v"], [f, "f"]].forEach(function (pair) {
      pair[0].blocks.forEach(function (b) {
        var ex = bseen[b.name];
        if (ex) { ex["ref" + pair[1]] = true; return; }
        var count = b.array || 1;
        for (var k = 0; k < count; k++) {
          var bname = b.array ? b.name + "[" + k + "]" : b.name, idx = blocks.length, entries = [];
          var prefix = b.instance ? b.name + "." : "";
          var size = std140(b.fields, structs, prefix, entries, idx, 0);
          var blk = { name: bname, size: Math.ceil(size / 16) * 16, binding: 0, first: uniforms.length, count: entries.length, refv: pair[1] === "v", reff: pair[1] === "f" };
          if (k === 0) bseen[b.name] = blk;
          blocks.push(blk);
          if (k === 0) entries.forEach(function (e) { uniforms.push(e); });
          else { blk.first = bseen[b.name].first; blk.count = bseen[b.name].count; }
        }
      });
    });
    // attribute locations: layout(location), bindAttribLocation, then the first free slots
    var attribs = [], used = Object.create(null), bound = p._bindings || {};
    v.attribs.forEach(function (a) {
      if (!TYPES[a.type]) return;
      var e = { name: a.name, size: a.array || 1, type: TYPES[a.type][0], slots: (ATTR_SLOTS[a.type] || 1) * (a.array || 1), loc: a.loc !== null && a.loc !== undefined ? a.loc : (a.name in bound ? bound[a.name] : null) };
      if (e.loc !== null) for (var q = 0; q < e.slots; q++) used[e.loc + q] = true;
      attribs.push(e);
    });
    attribs.forEach(function (e) {
      if (e.loc !== null) return;
      for (var l = 0; l < 16; l++) { var free = true; for (var q = 0; q < e.slots; q++) if (used[l + q]) { free = false; break; } if (free) { e.loc = l; for (q = 0; q < e.slots; q++) used[l + q] = true; break; } }
      if (e.loc === null) e.loc = 0;
    });
    var byBase = Object.create(null);
    uniforms.forEach(function (u, i) { u.index = i; byBase[u.base] = u; });
    p._uniforms = uniforms; p._uniformByBase = byBase; p._blocks = blocks; p._attribs = attribs;
    p._fragOuts = f.outs || []; p._values = Object.create(null); p._linked = true; p._log = "";
    p._tfLinked = (p._tfVaryings || []).map(function (n) { var o = (v.outs || []).find(function (x) { return x.name === n; }); return { name: n, size: o && o.array ? o.array : 1, type: o && TYPES[o.type] ? TYPES[o.type][0] : G.FLOAT_VEC4 }; });
    p._tfModeLinked = p._tfMode || G.SEPARATE_ATTRIBS;
  }
  // "u", "u[0]", "u[3]", "s.f", "s[1].f[2]" -> {u (entry), el (element)}
  function lookupUniform(p, name) {
    name = String(name);
    if (/^(gl_|webgl_|_webgl_)/.test(name)) return null;
    var m = /^(.*?)(?:\[(\d+)\])?$/.exec(name), base = m[1], el = m[2] !== undefined ? +m[2] : 0;
    var u = p._uniformByBase[base];
    if (!u && m[2] !== undefined) return null;
    if (!u) return null;
    if (u.block !== -1) return null;
    if (m[2] !== undefined && el >= u.size) return null;
    if (m[2] !== undefined && u.size === 1 && u.name.slice(-3) !== "[0]") return null;
    return { u: u, el: el };
  }
  function uniformDefault(u) {
    var t = TYPES[u.tname] || [u.type, 1, "f"];
    var n = t[1];
    if (t[2] === "b") return n === 1 ? false : new Array(n).fill(false);
    if (t[2] === "i" || t[2] === "s") return n === 1 ? 0 : new Int32Array(n);
    if (t[2] === "u") return n === 1 ? 0 : new Uint32Array(n);
    return n === 1 ? 0 : new Float32Array(n);
  }
  function storeUniform(ctx, loc, values) {
    var s = ctx._gls;
    if (loc === null || loc === undefined) return;
    if (!(loc instanceof WebGLUniformLocation) || loc._glctx !== ctx) return;
    if (loc._program !== s.program || loc._link !== loc._program._linkCount) return;
    var u = loc._u, t = TYPES[u.tname] || [u.type, 1, "f"], n = t[1];
    var arr = Array.prototype.slice.call(values);
    for (var e = loc._el, off = 0; e < u.size && off < arr.length; e++, off += n) {
      var chunk = arr.slice(off, off + n), v;
      if (t[2] === "b") v = n === 1 ? !!chunk[0] : chunk.map(function (x) { return !!x; });
      else if (t[2] === "i" || t[2] === "s") v = n === 1 ? (chunk[0] | 0) : Int32Array.from(chunk);
      else if (t[2] === "u") v = n === 1 ? (chunk[0] >>> 0) : Uint32Array.from(chunk);
      else v = n === 1 ? +chunk[0] : Float32Array.from(chunk);
      loc._program._values[u.base + "#" + e] = v;
    }
  }
  function viewSlice(data, srcOffset, srcLength) {
    if (!data || typeof data.length !== "number") return [];
    var off = srcOffset || 0, len = srcLength || (data.length - off);
    return Array.prototype.slice.call(data, off, off + len);
  }
  function fillZero(view, offset, length) {
    if (view && ArrayBuffer.isView(view)) { try { var off = offset || 0; view.fill ? view.fill(0, off, length ? off + length : undefined) : new Uint8Array(view.buffer, view.byteOffset, view.byteLength).fill(0); } catch (e) {} }
  }

  var impl = {
    getContextAttributes: function () { var s = this._gls; if (s.lost) return null; return Object.assign({}, s.attrs); },
    isContextLost: function () { return this._gls.lost; },
    getSupportedExtensions: function () { var s = this._gls; if (s.lost) return null; return (s.version === 2 ? EXT2 : EXT1).slice(); },
    getExtension: function (name) {
      var s = this._gls; name = String(name);
      if (s.lost && name !== "WEBGL_lose_context") return null;
      var list = s.version === 2 ? EXT2 : EXT1, real = null;
      for (var i = 0; i < list.length; i++) if (list[i].toLowerCase() === name.toLowerCase()) real = list[i];
      if (!real) return null;
      return s.exts[real] || (s.exts[real] = makeExtension(this, real));
    },
    getError: function () { var s = this._gls; if (s.errorLost) { s.errorLost = false; return G.CONTEXT_LOST_WEBGL; } return G.NO_ERROR; },

    // ---- objects
    createBuffer: function () { return mk(OBJ.WebGLBuffer, this, { _size: 0, _usage: G.STATIC_DRAW, _bound: false }); },
    createFramebuffer: function () { return mk(OBJ.WebGLFramebuffer, this, { _att: Object.create(null), _bound: false }); },
    createRenderbuffer: function () { return mk(OBJ.WebGLRenderbuffer, this, { _w: 0, _h: 0, _fmt: G.RGBA4, _samples: 0, _bound: false }); },
    createTexture: function () { return mk(OBJ.WebGLTexture, this, { _params: Object.create(null), _target: 0, _immutable: false, _levels: 0 }); },
    createProgram: function () { return mk(OBJ.WebGLProgram, this, { _shaders: [], _linked: false, _log: "", _bindings: Object.create(null), _uniforms: [], _uniformByBase: Object.create(null), _blocks: [], _attribs: [], _validated: false, _linkCount: 0 }); },
    createShader: function (type) { if (type !== G.VERTEX_SHADER && type !== G.FRAGMENT_SHADER) return null; return mk(OBJ.WebGLShader, this, { _kind: type, _src: "", _compiled: false, _scan: null }); },
    createVertexArray: function () { return newVao(this); },
    createQuery: function () { return mk(OBJ.WebGLQuery, this, { _target: 0 }); },
    createSampler: function () { return mk(OBJ.WebGLSampler, this, { _params: Object.create(null) }); },
    createTransformFeedback: function () { return mk(OBJ.WebGLTransformFeedback, this, { _active: false, _paused: false, _bound: false }); },
    fenceSync: function (cond, flags) { return mk(OBJ.WebGLSync, this, {}); },
    deleteBuffer: function (b) { var s = this._gls; if (!own(this, b)) return; b._deleted = true; for (var k in s.buffers) if (s.buffers[k] === b) s.buffers[k] = null; if (s.vao._elements === b) s.vao._elements = null; s.vao._attrs.forEach(function (a) { if (a.buffer === b) a.buffer = null; }); },
    deleteFramebuffer: function (f) { var s = this._gls; if (!own(this, f)) return; f._deleted = true; if (s.fb.draw === f) s.fb.draw = null; if (s.fb.read === f) s.fb.read = null; },
    deleteRenderbuffer: function (r) { var s = this._gls; if (!own(this, r)) return; r._deleted = true; if (s.rb === r) s.rb = null; },
    deleteTexture: function (t) { var s = this._gls; if (!own(this, t)) return; t._deleted = true; s.units.forEach(function (u) { for (var k in u) if (u[k] === t) u[k] = null; }); },
    deleteProgram: function (p) { var s = this._gls; if (!own(this, p)) return; p._deleted = true; },
    deleteShader: function (sh) { if (!own(this, sh)) return; sh._deleted = true; },
    deleteVertexArray: function (v) { var s = this._gls; if (!own(this, v)) return; v._deleted = true; if (s.vao === v) s.vao = s.defaultVao; },
    deleteQuery: function (q) { if (own(this, q)) q._deleted = true; },
    deleteSampler: function (x) { var s = this._gls; if (!own(this, x)) return; x._deleted = true; s.units.forEach(function (u) { if (u.sampler === x) u.sampler = null; }); },
    deleteSync: function (x) { if (own(this, x)) x._deleted = true; },
    deleteTransformFeedback: function (x) { var s = this._gls; if (!own(this, x)) return; x._deleted = true; if (s.tf === x) s.tf = null; },
    isBuffer: function (b) { return own(this, b) && b._bound; },
    isFramebuffer: function (f) { return own(this, f) && f._bound; },
    isRenderbuffer: function (r) { return own(this, r) && r._bound; },
    isTexture: function (t) { return own(this, t) && !!t._target; },
    isProgram: function (p) { return own(this, p); },
    isShader: function (sh) { return own(this, sh); },
    isVertexArray: function (v) { return own(this, v) && v._bound; },
    isQuery: function (q) { return own(this, q) && !!q._target; },
    isSampler: function (x) { return own(this, x); },
    isSync: function (x) { return own(this, x); },
    isTransformFeedback: function (x) { return own(this, x) && x._bound; },

    // ---- bindings
    bindBuffer: function (target, b) {
      var s = this._gls; if (b && !own(this, b)) return;
      if (b) b._bound = true;
      if (target === G.ELEMENT_ARRAY_BUFFER) s.vao._elements = b || null; else s.buffers[target] = b || null;
    },
    bindBufferBase: function (target, index, b) { var s = this._gls; if (b && !own(this, b)) return; if (b) b._bound = true; s.buffers[target] = b || null; s.indexed[target + ":" + index] = { b: b || null, start: 0, size: 0 }; },
    bindBufferRange: function (target, index, b, offset, size) { var s = this._gls; if (b && !own(this, b)) return; if (b) b._bound = true; s.buffers[target] = b || null; s.indexed[target + ":" + index] = { b: b || null, start: offset, size: size }; },
    bindFramebuffer: function (target, f) {
      var s = this._gls; if (f && !own(this, f)) return; if (f) f._bound = true;
      if (target === G.FRAMEBUFFER) { s.fb.draw = f || null; s.fb.read = f || null; } else if (target === G.DRAW_FRAMEBUFFER) s.fb.draw = f || null; else if (target === G.READ_FRAMEBUFFER) s.fb.read = f || null;
    },
    bindRenderbuffer: function (target, r) { var s = this._gls; if (r && !own(this, r)) return; if (r) r._bound = true; s.rb = r || null; },
    bindTexture: function (target, t) { var s = this._gls; if (t && !own(this, t)) return; var k = texSlot(target); if (!k) return; if (t && !t._target) t._target = target; s.units[s.activeUnit][k] = t || null; },
    bindVertexArray: function (v) { var s = this._gls; if (v && !own(this, v)) return; if (v) v._bound = true; s.vao = v || s.defaultVao; },
    bindSampler: function (unit, x) { var s = this._gls; if (x && !own(this, x)) return; if (s.units[unit]) s.units[unit].sampler = x || null; },
    bindTransformFeedback: function (target, x) { var s = this._gls; if (x && !own(this, x)) return; if (x) x._bound = true; s.tf = x || null; },
    activeTexture: function (unit) { var i = unit - G.TEXTURE0; if (i >= 0 && i < 32) this._gls.activeUnit = i; },
    useProgram: function (p) { var s = this._gls; if (p && !own(this, p)) return; s.program = p || null; },

    // ---- buffers
    bufferData: function (target, data, usage) {
      var s = this._gls, b = target === G.ELEMENT_ARRAY_BUFFER ? s.vao._elements : s.buffers[target];
      if (!b) return;
      var size = typeof data === "number" ? data : data && data.byteLength !== undefined ? data.byteLength : 0;
      if (arguments.length >= 5 && arguments[4]) size = arguments[4] * (data && data.BYTES_PER_ELEMENT || 1);
      b._size = size >>> 0; b._usage = usage;
    },
    bufferSubData: noop, copyBufferSubData: noop,
    getBufferSubData: function (target, srcByteOffset, dst, dstOffset, length) { fillZero(dst, dstOffset, length); },
    getBufferParameter: function (target, pname) {
      var s = this._gls, b = target === G.ELEMENT_ARRAY_BUFFER ? s.vao._elements : s.buffers[target];
      if (!b) return null;
      if (pname === G.BUFFER_SIZE) return b._size; if (pname === G.BUFFER_USAGE) return b._usage; return null;
    },

    // ---- shaders and programs
    shaderSource: function (sh, src) { if (!own(this, sh)) return; sh._src = String(src); },
    getShaderSource: function (sh) { return own(this, sh) ? sh._src : null; },
    compileShader: function (sh) { if (!own(this, sh)) return; try { sh._scan = scan(preprocess(sh._src, sh._kind)); } catch (e) { sh._scan = null; } sh._compiled = true; },
    getShaderParameter: function (sh, pname) {
      if (!own(this, sh)) return null;
      if (pname === G.SHADER_TYPE) return sh._kind; if (pname === G.DELETE_STATUS) return sh._deleted; if (pname === G.COMPILE_STATUS) return sh._compiled;
      if (pname === 0x91B1) return true; return null;
    },
    getShaderInfoLog: function (sh) { return own(this, sh) ? "" : null; },
    getShaderPrecisionFormat: function (shaderType, precisionType) {
      var o = Object.create(WebGLShaderPrecisionFormat.prototype), isInt = precisionType >= G.LOW_INT && precisionType <= G.HIGH_INT;
      hidden(o, "_min", isInt ? 31 : 127); hidden(o, "_max", isInt ? 30 : 127); hidden(o, "_prec", isInt ? 0 : 23);
      return o;
    },
    attachShader: function (p, sh) { if (!own(this, p) || !own(this, sh)) return; if (p._shaders.indexOf(sh) < 0 && !p._shaders.some(function (x) { return x._kind === sh._kind; })) p._shaders.push(sh); },
    detachShader: function (p, sh) { if (!own(this, p)) return; var i = p._shaders.indexOf(sh); if (i >= 0) p._shaders.splice(i, 1); },
    getAttachedShaders: function (p) { return own(this, p) ? p._shaders.slice() : null; },
    bindAttribLocation: function (p, index, name) { if (!own(this, p)) return; p._bindings[String(name)] = index >>> 0; },
    linkProgram: function (p) { if (!own(this, p)) return; linkProgram(this, p); },
    validateProgram: function (p) { if (own(this, p)) p._validated = p._linked; },
    getProgramParameter: function (p, pname) {
      if (!own(this, p)) return null;
      switch (pname) {
        case G.DELETE_STATUS: return p._deleted;
        case G.LINK_STATUS: return p._linked;
        case G.VALIDATE_STATUS: return p._validated;
        case G.ATTACHED_SHADERS: return p._shaders.length;
        case G.ACTIVE_ATTRIBUTES: return p._attribs.length;
        case G.ACTIVE_UNIFORMS: return p._uniforms.length;
        case G.ACTIVE_UNIFORM_BLOCKS: return this._gls.version === 2 ? p._blocks.length : null;
        case G.TRANSFORM_FEEDBACK_BUFFER_MODE: return this._gls.version === 2 ? (p._tfModeLinked || G.SEPARATE_ATTRIBS) : null;
        case G.TRANSFORM_FEEDBACK_VARYINGS: return this._gls.version === 2 ? (p._tfLinked || []).length : null;
        case 0x91B1: return true;
      }
      return null;
    },
    getProgramInfoLog: function (p) { return own(this, p) ? p._log : null; },
    getActiveAttrib: function (p, i) { if (!own(this, p)) return null; var a = p._attribs[i]; return a ? activeInfo(a) : null; },
    getActiveUniform: function (p, i) { if (!own(this, p)) return null; var u = p._uniforms[i]; return u ? activeInfo(u) : null; },
    getAttribLocation: function (p, name) { if (!own(this, p) || !p._linked) return -1; var a = p._attribs.find(function (x) { return x.name === String(name); }); return a ? a.loc : -1; },
    getFragDataLocation: function (p, name) { if (!own(this, p) || !p._linked) return -1; var o = (p._fragOuts || []).find(function (x) { return x.name === String(name); }); return o ? o.loc : -1; },
    getUniformLocation: function (p, name) {
      if (!own(this, p) || !p._linked) return null;
      var r = lookupUniform(p, name);
      if (!r) return null;
      var loc = Object.create(WebGLUniformLocation.prototype);
      hidden(loc, "_glctx", this); hidden(loc, "_program", p); hidden(loc, "_u", r.u); hidden(loc, "_el", r.el); hidden(loc, "_link", p._linkCount);
      return loc;
    },
    getUniform: function (p, loc) {
      if (!own(this, p) || !loc || loc._program !== p) return null;
      var v = p._values[loc._u.base + "#" + loc._el];
      if (v === undefined) v = uniformDefault(loc._u);
      return v && typeof v === "object" ? (Array.isArray(v) ? v.slice() : v.slice()) : v;
    },
    getUniformBlockIndex: function (p, name) { if (!own(this, p)) return G.INVALID_INDEX; for (var i = 0; i < p._blocks.length; i++) if (p._blocks[i].name === String(name)) return i; return G.INVALID_INDEX; },
    getUniformIndices: function (p, names) {
      if (!own(this, p)) return null;
      return Array.from(names || []).map(function (n) { n = String(n); for (var i = 0; i < p._uniforms.length; i++) if (p._uniforms[i].name === n || p._uniforms[i].base === n) return i; return G.INVALID_INDEX; });
    },
    getActiveUniforms: function (p, indices, pname) {
      if (!own(this, p)) return null;
      return Array.from(indices || []).map(function (i) {
        var u = p._uniforms[i]; if (!u) return null;
        switch (pname) {
          case G.UNIFORM_TYPE: return u.type; case G.UNIFORM_SIZE: return u.size; case G.UNIFORM_BLOCK_INDEX: return u.block;
          case G.UNIFORM_OFFSET: return u.block === -1 ? -1 : u.offset; case G.UNIFORM_ARRAY_STRIDE: return u.block === -1 ? -1 : u.arrayStride;
          case G.UNIFORM_MATRIX_STRIDE: return u.block === -1 ? -1 : u.matrixStride; case G.UNIFORM_IS_ROW_MAJOR: return false;
        }
        return null;
      });
    },
    getActiveUniformBlockName: function (p, i) { return own(this, p) && p._blocks[i] ? p._blocks[i].name : null; },
    getActiveUniformBlockParameter: function (p, i, pname) {
      if (!own(this, p)) return null; var b = p._blocks[i]; if (!b) return null;
      switch (pname) {
        case G.UNIFORM_BLOCK_BINDING: return b.binding; case G.UNIFORM_BLOCK_DATA_SIZE: return b.size; case G.UNIFORM_BLOCK_ACTIVE_UNIFORMS: return b.count;
        case G.UNIFORM_BLOCK_ACTIVE_UNIFORM_INDICES: var a = new Uint32Array(b.count); for (var k = 0; k < b.count; k++) a[k] = b.first + k; return a;
        case G.UNIFORM_BLOCK_REFERENCED_BY_VERTEX_SHADER: return b.refv; case G.UNIFORM_BLOCK_REFERENCED_BY_FRAGMENT_SHADER: return b.reff;
      }
      return null;
    },
    uniformBlockBinding: function (p, i, binding) { if (own(this, p) && p._blocks[i]) p._blocks[i].binding = binding >>> 0; },
    transformFeedbackVaryings: function (p, varyings, mode) { if (!own(this, p)) return; p._tfVaryings = Array.from(varyings || []).map(String); p._tfMode = mode; },
    getTransformFeedbackVarying: function (p, i) { if (!own(this, p)) return null; var v = (p._tfLinked || [])[i]; return v ? activeInfo(v) : null; },

    // ---- vertex attributes
    enableVertexAttribArray: function (i) { var a = this._gls.vao._attrs[i]; if (a) a.enabled = true; },
    disableVertexAttribArray: function (i) { var a = this._gls.vao._attrs[i]; if (a) a.enabled = false; },
    vertexAttribPointer: function (i, size, type, normalized, stride, offset) { var s = this._gls, a = s.vao._attrs[i]; if (!a) return; Object.assign(a, { size: size, type: type, normalized: !!normalized, stride: stride, offset: offset, buffer: s.buffers[G.ARRAY_BUFFER] || null, integer: false }); },
    vertexAttribIPointer: function (i, size, type, stride, offset) { var s = this._gls, a = s.vao._attrs[i]; if (!a) return; Object.assign(a, { size: size, type: type, normalized: false, stride: stride, offset: offset, buffer: s.buffers[G.ARRAY_BUFFER] || null, integer: true }); },
    vertexAttribDivisor: function (i, d) { var a = this._gls.vao._attrs[i]; if (a) a.divisor = d >>> 0; },
    getVertexAttrib: function (i, pname) {
      var s = this._gls, a = s.vao._attrs[i]; if (!a) return null;
      switch (pname) {
        case G.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING: return a.buffer; case G.VERTEX_ATTRIB_ARRAY_ENABLED: return a.enabled; case G.VERTEX_ATTRIB_ARRAY_SIZE: return a.size;
        case G.VERTEX_ATTRIB_ARRAY_STRIDE: return a.stride; case G.VERTEX_ATTRIB_ARRAY_TYPE: return a.type; case G.VERTEX_ATTRIB_ARRAY_NORMALIZED: return a.normalized;
        case G.VERTEX_ATTRIB_ARRAY_INTEGER: return a.integer; case G.VERTEX_ATTRIB_ARRAY_DIVISOR: return a.divisor; case G.CURRENT_VERTEX_ATTRIB: return new Float32Array(s.current[i]);
      }
      return null;
    },
    getVertexAttribOffset: function (i, pname) { var a = this._gls.vao._attrs[i]; return a ? a.offset : 0; },

    // ---- textures, renderbuffers, framebuffers
    texParameteri: function (target, pname, v) { var t = boundTex(this._gls, target); if (t) t._params[pname] = v; },
    texParameterf: function (target, pname, v) { var t = boundTex(this._gls, target); if (t) t._params[pname] = v; },
    getTexParameter: function (target, pname) {
      var t = boundTex(this._gls, target); if (!t) return null;
      if (pname in t._params) return t._params[pname];
      var d = {}; d[G.TEXTURE_MAG_FILTER] = G.LINEAR; d[G.TEXTURE_MIN_FILTER] = G.NEAREST_MIPMAP_LINEAR; d[G.TEXTURE_WRAP_S] = G.REPEAT; d[G.TEXTURE_WRAP_T] = G.REPEAT; d[G.TEXTURE_WRAP_R] = G.REPEAT;
      d[G.TEXTURE_BASE_LEVEL] = 0; d[G.TEXTURE_MAX_LEVEL] = 1000; d[G.TEXTURE_MIN_LOD] = -1000; d[G.TEXTURE_MAX_LOD] = 1000; d[G.TEXTURE_COMPARE_MODE] = G.NONE; d[G.TEXTURE_COMPARE_FUNC] = G.LEQUAL;
      d[G.TEXTURE_IMMUTABLE_FORMAT] = t._immutable; d[G.TEXTURE_IMMUTABLE_LEVELS] = t._levels; d[0x84FE] = 1;
      return pname in d ? d[pname] : null;
    },
    texImage2D: noop, texSubImage2D: noop, texImage3D: noop, texSubImage3D: noop, copyTexImage2D: noop, copyTexSubImage2D: noop, copyTexSubImage3D: noop,
    compressedTexImage2D: noop, compressedTexSubImage2D: noop, compressedTexImage3D: noop, compressedTexSubImage3D: noop, generateMipmap: noop,
    texStorage2D: function (target, levels) { var t = boundTex(this._gls, target); if (t) { t._immutable = true; t._levels = levels; } },
    texStorage3D: function (target, levels) { var t = boundTex(this._gls, target); if (t) { t._immutable = true; t._levels = levels; } },
    renderbufferStorage: function (target, fmt, w, h) { var r = this._gls.rb; if (r) { r._fmt = fmt; r._w = w; r._h = h; r._samples = 0; } },
    renderbufferStorageMultisample: function (target, samples, fmt, w, h) { var r = this._gls.rb; if (r) { r._fmt = fmt; r._w = w; r._h = h; r._samples = samples; } },
    getRenderbufferParameter: function (target, pname) {
      var r = this._gls.rb; if (!r) return null;
      switch (pname) {
        case G.RENDERBUFFER_WIDTH: return r._w; case G.RENDERBUFFER_HEIGHT: return r._h; case G.RENDERBUFFER_INTERNAL_FORMAT: return r._fmt; case G.RENDERBUFFER_SAMPLES: return r._samples;
        case G.RENDERBUFFER_RED_SIZE: case G.RENDERBUFFER_GREEN_SIZE: case G.RENDERBUFFER_BLUE_SIZE: case G.RENDERBUFFER_ALPHA_SIZE: return /^(32856|32855|36194)$/.test(String(r._fmt)) ? 8 : 0;
        case G.RENDERBUFFER_DEPTH_SIZE: return r._fmt === G.DEPTH_COMPONENT16 ? 16 : (r._fmt === G.DEPTH_STENCIL || r._fmt === G.DEPTH24_STENCIL8 || r._fmt === G.DEPTH_COMPONENT24) ? 24 : 0;
        case G.RENDERBUFFER_STENCIL_SIZE: return r._fmt === G.STENCIL_INDEX8 || r._fmt === G.DEPTH_STENCIL || r._fmt === G.DEPTH24_STENCIL8 ? 8 : 0;
      }
      return null;
    },
    framebufferRenderbuffer: function (target, att, rbTarget, r) { var f = boundFb(this._gls, target); if (f) f._att[att] = r ? { kind: G.RENDERBUFFER, obj: r } : null; },
    framebufferTexture2D: function (target, att, texTarget, t, level) { var f = boundFb(this._gls, target); if (f) f._att[att] = t ? { kind: G.TEXTURE, obj: t, level: level, face: texTarget >= G.TEXTURE_CUBE_MAP_POSITIVE_X && texTarget <= G.TEXTURE_CUBE_MAP_NEGATIVE_Z ? texTarget : 0 } : null; },
    framebufferTextureLayer: function (target, att, t, level, layer) { var f = boundFb(this._gls, target); if (f) f._att[att] = t ? { kind: G.TEXTURE, obj: t, level: level, layer: layer } : null; },
    getFramebufferAttachmentParameter: function (target, att, pname) {
      var f = boundFb(this._gls, target);
      if (!f) { if (pname === G.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE) return G.FRAMEBUFFER_DEFAULT; if (pname === G.FRAMEBUFFER_ATTACHMENT_COLOR_ENCODING) return G.LINEAR; if (pname === G.FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE) return G.UNSIGNED_NORMALIZED; return 8; }
      var a = f._att[att];
      if (pname === G.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE) return a ? a.kind : G.NONE;
      if (!a) return null;
      switch (pname) {
        case G.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME: return a.obj; case G.FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL: return a.level || 0;
        case G.FRAMEBUFFER_ATTACHMENT_TEXTURE_CUBE_MAP_FACE: return a.face || 0; case G.FRAMEBUFFER_ATTACHMENT_TEXTURE_LAYER: return a.layer || 0;
        case G.FRAMEBUFFER_ATTACHMENT_COLOR_ENCODING: return G.LINEAR; case G.FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE: return G.UNSIGNED_NORMALIZED;
      }
      return 8;
    },
    checkFramebufferStatus: function (target) { return G.FRAMEBUFFER_COMPLETE; },
    blitFramebuffer: noop, invalidateFramebuffer: noop, invalidateSubFramebuffer: noop,
    readBuffer: function (src) { this._gls.readBuffer = src; },
    drawBuffers: function (b) { this._gls.drawBuffers = Array.from(b || []); },
    getInternalformatParameter: function (target, fmt, pname) { return pname === G.SAMPLES ? new Int32Array([4, 2, 1]) : null; },
    readPixels: function (x, y, w, h, format, type, dst, dstOffset) { if (dst && typeof dst === "object") fillZero(dst, typeof dstOffset === "number" ? dstOffset : 0); },

    // ---- state
    enable: function (cap) { this._gls.caps[cap] = true; },
    disable: function (cap) { this._gls.caps[cap] = false; },
    isEnabled: function (cap) { return !!this._gls.caps[cap]; },
    blendColor: function (r, g, b, a) { this._gls.st[G.BLEND_COLOR] = [r, g, b, a]; },
    blendEquation: function (m) { var st = this._gls.st; st[G.BLEND_EQUATION_RGB] = m; st[G.BLEND_EQUATION_ALPHA] = m; },
    blendEquationSeparate: function (rgb, a) { var st = this._gls.st; st[G.BLEND_EQUATION_RGB] = rgb; st[G.BLEND_EQUATION_ALPHA] = a; },
    blendFunc: function (sf, df) { var st = this._gls.st; st[G.BLEND_SRC_RGB] = st[G.BLEND_SRC_ALPHA] = sf; st[G.BLEND_DST_RGB] = st[G.BLEND_DST_ALPHA] = df; },
    blendFuncSeparate: function (sr, dr, sa, da) { var st = this._gls.st; st[G.BLEND_SRC_RGB] = sr; st[G.BLEND_DST_RGB] = dr; st[G.BLEND_SRC_ALPHA] = sa; st[G.BLEND_DST_ALPHA] = da; },
    clearColor: function (r, g, b, a) { this._gls.st[G.COLOR_CLEAR_VALUE] = [r, g, b, a]; },
    clearDepth: function (d) { this._gls.st[G.DEPTH_CLEAR_VALUE] = d; },
    clearStencil: function (v) { this._gls.st[G.STENCIL_CLEAR_VALUE] = v; },
    colorMask: function (r, g, b, a) { this._gls.st[G.COLOR_WRITEMASK] = [!!r, !!g, !!b, !!a]; },
    cullFace: function (m) { this._gls.st[G.CULL_FACE_MODE] = m; },
    depthFunc: function (f) { this._gls.st[G.DEPTH_FUNC] = f; },
    depthMask: function (f) { this._gls.st[G.DEPTH_WRITEMASK] = !!f; },
    depthRange: function (n, f) { this._gls.st[G.DEPTH_RANGE] = [n, f]; },
    frontFace: function (m) { this._gls.st[G.FRONT_FACE] = m; },
    hint: function (target, mode) { this._gls.st[target] = mode; },
    lineWidth: function (w) { this._gls.st[G.LINE_WIDTH] = w; },
    pixelStorei: function (pname, v) { var st = this._gls.st; st[pname] = (pname === G.UNPACK_FLIP_Y_WEBGL || pname === G.UNPACK_PREMULTIPLY_ALPHA_WEBGL) ? !!v : v; },
    polygonOffset: function (f, u) { var st = this._gls.st; st[G.POLYGON_OFFSET_FACTOR] = f; st[G.POLYGON_OFFSET_UNITS] = u; },
    sampleCoverage: function (v, inv) { var st = this._gls.st; st[G.SAMPLE_COVERAGE_VALUE] = v; st[G.SAMPLE_COVERAGE_INVERT] = !!inv; },
    scissor: function (x, y, w, h) { this._gls.st[G.SCISSOR_BOX] = [x, y, w, h]; },
    viewport: function (x, y, w, h) { this._gls.st[G.VIEWPORT] = [x, y, w, h]; },
    stencilFunc: function (f, ref, mask) { var st = this._gls.st; st[G.STENCIL_FUNC] = st[G.STENCIL_BACK_FUNC] = f; st[G.STENCIL_REF] = st[G.STENCIL_BACK_REF] = ref; st[G.STENCIL_VALUE_MASK] = st[G.STENCIL_BACK_VALUE_MASK] = mask >>> 0; },
    stencilFuncSeparate: function (face, f, ref, mask) { var st = this._gls.st; if (face !== G.BACK) { st[G.STENCIL_FUNC] = f; st[G.STENCIL_REF] = ref; st[G.STENCIL_VALUE_MASK] = mask >>> 0; } if (face !== G.FRONT) { st[G.STENCIL_BACK_FUNC] = f; st[G.STENCIL_BACK_REF] = ref; st[G.STENCIL_BACK_VALUE_MASK] = mask >>> 0; } },
    stencilMask: function (m) { var st = this._gls.st; st[G.STENCIL_WRITEMASK] = st[G.STENCIL_BACK_WRITEMASK] = m >>> 0; },
    stencilMaskSeparate: function (face, m) { var st = this._gls.st; if (face !== G.BACK) st[G.STENCIL_WRITEMASK] = m >>> 0; if (face !== G.FRONT) st[G.STENCIL_BACK_WRITEMASK] = m >>> 0; },
    stencilOp: function (a, b, c) { var st = this._gls.st; st[G.STENCIL_FAIL] = st[G.STENCIL_BACK_FAIL] = a; st[G.STENCIL_PASS_DEPTH_FAIL] = st[G.STENCIL_BACK_PASS_DEPTH_FAIL] = b; st[G.STENCIL_PASS_DEPTH_PASS] = st[G.STENCIL_BACK_PASS_DEPTH_PASS] = c; },
    stencilOpSeparate: function (face, a, b, c) { var st = this._gls.st; if (face !== G.BACK) { st[G.STENCIL_FAIL] = a; st[G.STENCIL_PASS_DEPTH_FAIL] = b; st[G.STENCIL_PASS_DEPTH_PASS] = c; } if (face !== G.FRONT) { st[G.STENCIL_BACK_FAIL] = a; st[G.STENCIL_BACK_PASS_DEPTH_FAIL] = b; st[G.STENCIL_BACK_PASS_DEPTH_PASS] = c; } },

    // ---- drawing: no rasterizer
    clear: noop, drawArrays: noop, drawElements: noop, drawArraysInstanced: noop, drawElementsInstanced: noop, drawRangeElements: noop,
    clearBufferfv: noop, clearBufferiv: noop, clearBufferuiv: noop, clearBufferfi: noop, finish: noop, flush: noop,
    makeXRCompatible: function () { return Promise.resolve(); },

    // ---- queries, samplers, syncs, transform feedback
    beginQuery: function (target, q) { if (own(this, q)) { q._target = target; this._gls.queries[target] = q; } },
    endQuery: function (target) { this._gls.queries[target] = null; },
    getQuery: function (target, pname) { return pname === G.CURRENT_QUERY ? this._gls.queries[target] || null : null; },
    getQueryParameter: function (q, pname) { if (!own(this, q)) return null; if (pname === G.QUERY_RESULT_AVAILABLE) return true; if (pname === G.QUERY_RESULT) return 0; return null; },
    samplerParameteri: function (x, pname, v) { if (own(this, x)) x._params[pname] = v; },
    samplerParameterf: function (x, pname, v) { if (own(this, x)) x._params[pname] = v; },
    getSamplerParameter: function (x, pname) { if (!own(this, x)) return null; return pname in x._params ? x._params[pname] : null; },
    clientWaitSync: function (x) { return G.ALREADY_SIGNALED; },
    waitSync: noop,
    getSyncParameter: function (x, pname) { if (!own(this, x)) return null; switch (pname) { case G.OBJECT_TYPE: return G.SYNC_FENCE; case G.SYNC_STATUS: return G.SIGNALED; case G.SYNC_CONDITION: return G.SYNC_GPU_COMMANDS_COMPLETE; case G.SYNC_FLAGS: return 0; } return null; },
    beginTransformFeedback: function () { var t = this._gls.tf; if (t) t._active = true; },
    endTransformFeedback: function () { var t = this._gls.tf; if (t) { t._active = false; t._paused = false; } },
    pauseTransformFeedback: function () { var t = this._gls.tf; if (t) t._paused = true; },
    resumeTransformFeedback: function () { var t = this._gls.tf; if (t) t._paused = false; },
    getIndexedParameter: function (target, index) {
      var s = this._gls, e = s.indexed[(target === G.TRANSFORM_FEEDBACK_BUFFER_BINDING ? G.TRANSFORM_FEEDBACK_BUFFER : target === G.UNIFORM_BUFFER_BINDING ? G.UNIFORM_BUFFER : target) + ":" + index];
      if (target === G.TRANSFORM_FEEDBACK_BUFFER_BINDING || target === G.UNIFORM_BUFFER_BINDING) return e ? e.b : null;
      if (target === G.TRANSFORM_FEEDBACK_BUFFER_START || target === G.UNIFORM_BUFFER_START) { e = s.indexed[(target === G.UNIFORM_BUFFER_START ? G.UNIFORM_BUFFER : G.TRANSFORM_FEEDBACK_BUFFER) + ":" + index]; return e ? e.start : 0; }
      if (target === G.TRANSFORM_FEEDBACK_BUFFER_SIZE || target === G.UNIFORM_BUFFER_SIZE) { e = s.indexed[(target === G.UNIFORM_BUFFER_SIZE ? G.UNIFORM_BUFFER : G.TRANSFORM_FEEDBACK_BUFFER) + ":" + index]; return e ? e.size : 0; }
      return null;
    },
  };
  // uniform setters
  ["1", "2", "3", "4"].forEach(function (n) {
    ["f", "i", "ui"].forEach(function (k) {
      impl["uniform" + n + k] = function (loc) { storeUniform(this, loc, Array.prototype.slice.call(arguments, 1, 1 + +n)); };
      impl["uniform" + n + k + "v"] = function (loc, data, srcOffset, srcLength) { storeUniform(this, loc, viewSlice(data, srcOffset, srcLength)); };
    });
    impl["vertexAttrib" + n + "f"] = function (i) { var c = this._gls.current[i]; if (!c) return; var a = Array.prototype.slice.call(arguments, 1); for (var q = 0; q < 4; q++) c[q] = q < a.length ? +a[q] : (q === 3 ? 1 : 0); };
    impl["vertexAttrib" + n + "fv"] = function (i, v) { impl["vertexAttrib" + n + "f"].apply(this, [i].concat(Array.prototype.slice.call(v || [], 0, +n))); };
  });
  ["vertexAttribI4i", "vertexAttribI4ui"].forEach(function (m) { impl[m] = function (i, x, y, z, w) { var c = this._gls.current[i]; if (c) c.set([x, y, z, w]); }; impl[m + "v"] = function (i, v) { var c = this._gls.current[i]; if (c && v) c.set(Array.prototype.slice.call(v, 0, 4)); }; });
  ["2", "3", "4", "2x3", "2x4", "3x2", "3x4", "4x2", "4x3"].forEach(function (m) {
    impl["uniformMatrix" + m + "fv"] = function (loc, transpose, data, srcOffset, srcLength) { storeUniform(this, loc, viewSlice(data, srcOffset, srcLength)); };
  });

  // getParameter
  function limits(s) {
    var L = {};
    L[G.MAX_TEXTURE_SIZE] = 8192; L[G.MAX_CUBE_MAP_TEXTURE_SIZE] = 8192; L[G.MAX_RENDERBUFFER_SIZE] = 8192; L[G.MAX_VERTEX_ATTRIBS] = 16;
    L[G.MAX_VERTEX_UNIFORM_VECTORS] = 1024; L[G.MAX_FRAGMENT_UNIFORM_VECTORS] = 1024; L[G.MAX_VARYING_VECTORS] = 30; L[G.MAX_TEXTURE_IMAGE_UNITS] = 16;
    L[G.MAX_VERTEX_TEXTURE_IMAGE_UNITS] = 16; L[G.MAX_COMBINED_TEXTURE_IMAGE_UNITS] = 32; L[G.SUBPIXEL_BITS] = 4; L[0x84FF] = 16;
    if (s.version === 2) {
      L[G.MAX_3D_TEXTURE_SIZE] = 2048; L[G.MAX_ARRAY_TEXTURE_LAYERS] = 2048; L[G.MAX_DRAW_BUFFERS] = 8; L[G.MAX_COLOR_ATTACHMENTS] = 8; L[G.MAX_SAMPLES] = 4;
      L[G.MAX_UNIFORM_BUFFER_BINDINGS] = 24; L[G.MAX_UNIFORM_BLOCK_SIZE] = 65536; L[G.MAX_VERTEX_UNIFORM_BLOCKS] = 12; L[G.MAX_FRAGMENT_UNIFORM_BLOCKS] = 12; L[G.MAX_COMBINED_UNIFORM_BLOCKS] = 24;
      L[G.UNIFORM_BUFFER_OFFSET_ALIGNMENT] = 256; L[G.MAX_VERTEX_UNIFORM_COMPONENTS] = 4096; L[G.MAX_FRAGMENT_UNIFORM_COMPONENTS] = 4096; L[G.MAX_VARYING_COMPONENTS] = 120;
      L[G.MAX_VERTEX_OUTPUT_COMPONENTS] = 120; L[G.MAX_FRAGMENT_INPUT_COMPONENTS] = 120; L[G.MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS] = 64; L[G.MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS] = 4;
      L[G.MAX_TRANSFORM_FEEDBACK_SEPARATE_COMPONENTS] = 4; L[G.MAX_ELEMENT_INDEX] = 4294967295; L[G.MAX_ELEMENTS_VERTICES] = 1048575; L[G.MAX_ELEMENTS_INDICES] = 1048575;
      L[G.MAX_SERVER_WAIT_TIMEOUT] = 0; L[G.MAX_CLIENT_WAIT_TIMEOUT_WEBGL] = 0; L[G.MIN_PROGRAM_TEXEL_OFFSET] = -8; L[G.MAX_PROGRAM_TEXEL_OFFSET] = 7; L[G.MAX_TEXTURE_LOD_BIAS] = 2;
      L[G.MAX_COMBINED_VERTEX_UNIFORM_COMPONENTS] = 4096 + 12 * 16384; L[G.MAX_COMBINED_FRAGMENT_UNIFORM_COMPONENTS] = 4096 + 12 * 16384;
    } else { L[0x8CDF] = 8; L[0x8824] = 8; }
    return L;
  }
  var CAPS = [G.BLEND, G.CULL_FACE, G.DEPTH_TEST, G.DITHER, G.POLYGON_OFFSET_FILL, G.SAMPLE_ALPHA_TO_COVERAGE, G.SAMPLE_COVERAGE, G.SCISSOR_TEST, G.STENCIL_TEST, G.RASTERIZER_DISCARD];
  impl.getParameter = function (pname) {
    var s = this._gls, st = s.st, f32 = function (a) { return new Float32Array(a); }, i32 = function (a) { return new Int32Array(a); };
    var v1 = s.version === 1;
    switch (pname) {
      case G.VENDOR: return VENDOR;
      case G.RENDERER: return VENDOR;
      case 0x9245: return s.exts.WEBGL_debug_renderer_info ? VENDOR : null;
      case 0x9246: return s.exts.WEBGL_debug_renderer_info ? RENDERER : null;
      case G.VERSION: return v1 ? "WebGL 1.0 (OpenGL ES 2.0 julia-browser)" : "WebGL 2.0 (OpenGL ES 3.0 julia-browser)";
      case G.SHADING_LANGUAGE_VERSION: return v1 ? "WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 julia-browser)" : "WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.0 julia-browser)";
      case G.MAX_VIEWPORT_DIMS: return i32([8192, 8192]);
      case G.ALIASED_LINE_WIDTH_RANGE: return f32([1, 1]);
      case G.ALIASED_POINT_SIZE_RANGE: return f32([1, 1024]);
      case G.RED_BITS: case G.GREEN_BITS: case G.BLUE_BITS: return 8;
      case G.ALPHA_BITS: return s.attrs.alpha ? 8 : 0;
      case G.DEPTH_BITS: return s.attrs.depth ? 24 : 0;
      case G.STENCIL_BITS: return s.attrs.stencil ? 8 : 0;
      case G.SAMPLE_BUFFERS: return s.attrs.antialias ? 1 : 0;
      case G.SAMPLES: return s.attrs.antialias ? 4 : 0;
      case G.COMPRESSED_TEXTURE_FORMATS: return new Uint32Array(0);
      case G.IMPLEMENTATION_COLOR_READ_FORMAT: return G.RGBA;
      case G.IMPLEMENTATION_COLOR_READ_TYPE: return G.UNSIGNED_BYTE;
      case G.VIEWPORT: case G.SCISSOR_BOX: return i32(st[pname]);
      case G.COLOR_CLEAR_VALUE: case G.BLEND_COLOR: case G.DEPTH_RANGE: return f32(st[pname]);
      case G.COLOR_WRITEMASK: return st[pname].slice();
      case G.ARRAY_BUFFER_BINDING: return s.buffers[G.ARRAY_BUFFER] || null;
      case G.ELEMENT_ARRAY_BUFFER_BINDING: return s.vao._elements;
      case G.CURRENT_PROGRAM: return s.program;
      case G.FRAMEBUFFER_BINDING: return s.fb.draw;
      case G.RENDERBUFFER_BINDING: return s.rb;
      case G.ACTIVE_TEXTURE: return G.TEXTURE0 + s.activeUnit;
      case G.TEXTURE_BINDING_2D: return s.units[s.activeUnit].t2d;
      case G.TEXTURE_BINDING_CUBE_MAP: return s.units[s.activeUnit].cube;
      case G.VERTEX_ARRAY_BINDING: return (v1 && !s.exts.OES_vertex_array_object) ? null : (s.vao === s.defaultVao ? null : s.vao);
    }
    if (!v1) {
      switch (pname) {
        case G.TEXTURE_BINDING_3D: return s.units[s.activeUnit].t3d;
        case G.TEXTURE_BINDING_2D_ARRAY: return s.units[s.activeUnit].t2da;
        case G.READ_FRAMEBUFFER_BINDING: return s.fb.read;
        case G.SAMPLER_BINDING: return s.units[s.activeUnit].sampler;
        case G.TRANSFORM_FEEDBACK_BINDING: return s.tf;
        case G.COPY_READ_BUFFER_BINDING: return s.buffers[G.COPY_READ_BUFFER] || null;
        case G.COPY_WRITE_BUFFER_BINDING: return s.buffers[G.COPY_WRITE_BUFFER] || null;
        case G.PIXEL_PACK_BUFFER_BINDING: return s.buffers[G.PIXEL_PACK_BUFFER] || null;
        case G.PIXEL_UNPACK_BUFFER_BINDING: return s.buffers[G.PIXEL_UNPACK_BUFFER] || null;
        case G.UNIFORM_BUFFER_BINDING: return s.buffers[G.UNIFORM_BUFFER] || null;
        case G.TRANSFORM_FEEDBACK_BUFFER_BINDING: return s.buffers[G.TRANSFORM_FEEDBACK_BUFFER] || null;
        case G.READ_BUFFER: return s.readBuffer;
        case G.TRANSFORM_FEEDBACK_ACTIVE: return !!(s.tf && s.tf._active);
        case G.TRANSFORM_FEEDBACK_PAUSED: return !!(s.tf && s.tf._paused);
      }
      if (pname >= G.DRAW_BUFFER0 && pname <= G.DRAW_BUFFER0 + 15) { var db = s.drawBuffers[pname - G.DRAW_BUFFER0]; return db === undefined ? G.NONE : db; }
    }
    if (CAPS.indexOf(pname) >= 0) return !!s.caps[pname];
    var L = limits(s);
    if (pname in L) return L[pname];
    if (pname in st) return st[pname];
    return null;
  };

  // Methods that keep working (or answer fixed values) on a lost context.
  var LOST_KEEP = { isContextLost: 1, getError: 1, getExtension: 1, getContextAttributes: 1, getSupportedExtensions: 1, makeXRCompatible: 1 };
  function lostValue(name) {
    if (/^is/.test(name)) return false;
    if (name === "getAttribLocation" || name === "getFragDataLocation") return -1;
    if (name === "getUniformBlockIndex") return G.INVALID_INDEX;
    if (name === "checkFramebufferStatus") return G.FRAMEBUFFER_UNSUPPORTED;
    if (name === "clientWaitSync") return G.WAIT_FAILED;
    if (/^(get|create|fenceSync)/.test(name)) return null;
    return undefined;
  }
  var WEBGL2_ONLY = /^(copyBufferSubData|getBufferSubData|blitFramebuffer|framebufferTextureLayer|invalidate|readBuffer|getInternalformatParameter|renderbufferStorageMultisample|texStorage|texImage3D|texSubImage3D|copyTexSubImage3D|compressedTex(Sub)?Image3D|getFragDataLocation|uniform[1-4]ui|uniformMatrix\dx\d|vertexAttribI|vertexAttribDivisor|drawArraysInstanced|drawElementsInstanced|drawRangeElements|drawBuffers|clearBuffer|.*Query$|beginQuery|endQuery|getQuery|getQueryParameter|.*Sampler|samplerParameter|getSamplerParameter|fenceSync|.*Sync$|getSyncParameter|.*TransformFeedback|transformFeedbackVaryings|getTransformFeedbackVarying|bindBufferBase|bindBufferRange|getIndexedParameter|getUniformIndices|getActiveUniforms|getUniformBlockIndex|getActiveUniformBlock|uniformBlockBinding|.*VertexArray$|bindVertexArray)/;

  function buildProto(name, version) {
    var Ctor = defClass(name);
    var P = Ctor.prototype, K = version === 2 ? K2 : K1;
    Object.keys(K).forEach(function (k) { Object.defineProperty(P, k, { value: K[k], enumerable: true }); Object.defineProperty(Ctor, k, { value: K[k], enumerable: true }); });
    Object.keys(impl).forEach(function (m) {
      if (version === 1 && WEBGL2_ONLY.test(m) && m !== "isVertexArray") return;
      if (version === 1 && m === "isVertexArray") return;
      if (version === 1 && m === "vertexAttribDivisor") return;
      var f = impl[m], lv = lostValue(m), keep = LOST_KEEP[m];
      var w = { [m]: function () { var s = S(this); if (s.lost && !keep) return lv; return f.apply(this, arguments); } }[m];
      Object.defineProperty(P, m, { value: w, writable: true, enumerable: true, configurable: true });
    });
    Object.defineProperty(P, "canvas", { get: function () { return S(this).canvas; }, enumerable: true, configurable: true });
    Object.defineProperty(P, "drawingBufferWidth", { get: function () { return __jb.canvasSize(S(this).canvas)[0]; }, enumerable: true, configurable: true });
    Object.defineProperty(P, "drawingBufferHeight", { get: function () { return __jb.canvasSize(S(this).canvas)[1]; }, enumerable: true, configurable: true });
    Object.defineProperty(P, "drawingBufferColorSpace", { get: function () { return S(this).colorSpace; }, set: function (v) { if (v === "srgb" || v === "display-p3") S(this).colorSpace = v; }, enumerable: true, configurable: true });
    Object.defineProperty(P, "unpackColorSpace", { get: function () { return S(this).unpackColorSpace; }, set: function (v) { if (v === "srgb" || v === "display-p3") S(this).unpackColorSpace = v; }, enumerable: true, configurable: true });
    Object.defineProperty(P, "drawingBufferFormat", { get: function () { return G.RGBA8; }, enumerable: true, configurable: true });
    return Ctor;
  }
  var WebGLRenderingContext = buildProto("WebGLRenderingContext", 1);
  var WebGL2RenderingContext = buildProto("WebGL2RenderingContext", 2);

  function contextAttributes(attrs) {
    attrs = attrs && typeof attrs === "object" ? attrs : {};
    var b = function (k, d) { return attrs[k] === undefined ? d : !!attrs[k]; };
    var pp = attrs.powerPreference; if (pp !== "low-power" && pp !== "high-performance") pp = "default";
    return { alpha: b("alpha", true), antialias: b("antialias", true), depth: b("depth", true), desynchronized: b("desynchronized", false), failIfMajorPerformanceCaveat: b("failIfMajorPerformanceCaveat", false),
      powerPreference: pp, premultipliedAlpha: b("premultipliedAlpha", true), preserveDrawingBuffer: b("preserveDrawingBuffer", false), stencil: b("stencil", false), xrCompatible: b("xrCompatible", false) };
  }
  __jb.webglContext = function (canvas, type, attrs) {
    var version = type === "webgl2" ? 2 : 1, kind = version === 2 ? "webgl2" : "webgl";
    if (canvas._ctxType && canvas._ctxType !== kind) return null;
    if (canvas._ctxGL) return canvas._ctxGL;
    var ctx = Object.create((version === 2 ? WebGL2RenderingContext : WebGLRenderingContext).prototype);
    initState(ctx, version, contextAttributes(attrs), canvas);
    Object.defineProperty(canvas, "_ctxGL", { value: ctx, writable: true, configurable: true });
    canvas._ctxType = kind;
    // a transparent bitmap of the canvas size, so painting, toDataURL and transfers see a cleared canvas
    try { __jb.canvasId(canvas); var size = __jb.canvasSize(canvas); __jb.native("canvas", { op: "reset", id: canvas._canvasId, w: size[0], h: size[1] }); } catch (e) {}
    return ctx;
  };
  var RASTER_ONLY = /maps\.googleapis\.com\/|maps\.gstatic\.com\/|www\.google\.com\/maps\/|google\.com\/maps\/_\/js/;
  function rasterOnlyCaller() {
    try { return RASTER_ONLY.test(String(new Error().stack || "")); } catch (e) { return false; }
  }
  var baseContext = __jb.canvasContext;
  __jb.canvasContext = function (canvas, type, attrs) {
    var t = String(type);
    if ((t === "webgl" || t === "experimental-webgl" || t === "webgl2") && glOn()) {
      // Google Maps (the Maps JS API and google.com/maps) picks its WebGL renderer when a context
      // initialises, and our contexts draw nothing: the map never becomes ready (no tiles, no `idle`,
      // United's fares and Maps' place panel wait for it). Without WebGL it uses raster image tiles.
      if (rasterOnlyCaller()) return null;
      return __jb.webglContext(canvas, t, attrs);
    }
    return baseContext.apply(this, arguments);
  };

  // Interface objects: installed on real pages by __jb.realSiteShape (90_bridge.js).
  var INTERFACES = { WebGLRenderingContext: WebGLRenderingContext, WebGL2RenderingContext: WebGL2RenderingContext, WebGLObject: WebGLObject, WebGLUniformLocation: WebGLUniformLocation,
    WebGLActiveInfo: WebGLActiveInfo, WebGLShaderPrecisionFormat: WebGLShaderPrecisionFormat, WebGLContextEvent: WebGLContextEvent };
  ["WebGLBuffer", "WebGLFramebuffer", "WebGLProgram", "WebGLRenderbuffer", "WebGLShader", "WebGLTexture", "WebGLQuery", "WebGLSampler", "WebGLSync", "WebGLTransformFeedback", "WebGLVertexArrayObject"].forEach(function (n) { INTERFACES[n] = OBJ[n]; });
  __jb.installWebGL = function () {
    if (!glOn()) return;
    Object.keys(INTERFACES).forEach(function (n) { Object.defineProperty(globalThis, n, { value: INTERFACES[n], writable: true, configurable: true, enumerable: false }); });
  };
  __jb.glslScan = function (src, kind) { return scan(preprocess(src, kind === "fragment" ? G.FRAGMENT_SHADER : G.VERTEX_SHADER)); };
})();
