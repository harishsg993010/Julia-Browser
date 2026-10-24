// Part 5f: HTMLMediaElement as a virtual media pipeline (HTML "media elements").
// Resources are fetched and probed by the host (`media` op: duration, video
// size); nothing is decoded. The load/resource selection algorithm, ready
// states, play/pause/seek, the playback clock and their events follow the spec.
// Text tracks: TextTrack/TextTrackList/VTTCue/<track> with WebVTT parsing.
(function () {
  var M = __jb.htmlClasses.HTMLMediaElement;
  if (!M) return;
  var NETWORK = { EMPTY: 0, IDLE: 1, LOADING: 2, NO_SOURCE: 3 };
  var HAVE = { NOTHING: 0, METADATA: 1, CURRENT_DATA: 2, FUTURE_DATA: 3, ENOUGH_DATA: 4 };
  var defineConsts = function (C, map, prefix) { Object.keys(map).forEach(function (k) { [C, C.prototype].forEach(function (o) { Object.defineProperty(o, prefix + k, { value: map[k], enumerable: true, writable: false, configurable: false }); }); }); };
  defineConsts(M, NETWORK, "NETWORK_");
  defineConsts(M, HAVE, "HAVE_");

  // ---------------------------------------------------------- MediaError / TimeRanges
  class MediaError {
    constructor() { if (!__jb.mediaConstructing) throw new TypeError("Illegal constructor"); }
    get code() { return this._code; }
    get message() { return this._message || ""; }
  }
  defineConsts(MediaError, { ABORTED: 1, NETWORK: 2, DECODE: 3, SRC_NOT_SUPPORTED: 4 }, "MEDIA_ERR_");
  __jb.setTag(MediaError, "MediaError");
  var mediaError = function (code, msg) { __jb.mediaConstructing = true; try { var e = new MediaError(); } finally { __jb.mediaConstructing = false; } Object.defineProperty(e, "_code", { value: code }); Object.defineProperty(e, "_message", { value: msg || "" }); return e; };
  class TimeRanges {
    constructor() { if (!__jb.mediaConstructing) throw new TypeError("Illegal constructor"); }
    get length() { return this._r.length; }
    start(i) { if (arguments.length < 1) throw new TypeError("start: 1 argument required"); i = i >>> 0; if (i >= this._r.length) throw __jb.domError("IndexSizeError", "The index provided (" + i + ") is greater than or equal to the maximum bound (" + this._r.length + ")."); return this._r[i][0]; }
    end(i) { if (arguments.length < 1) throw new TypeError("end: 1 argument required"); i = i >>> 0; if (i >= this._r.length) throw __jb.domError("IndexSizeError", "The index provided (" + i + ") is greater than or equal to the maximum bound (" + this._r.length + ")."); return this._r[i][1]; }
  }
  __jb.setTag(TimeRanges, "TimeRanges");
  var ranges = function (list) { __jb.mediaConstructing = true; try { var r = new TimeRanges(); } finally { __jb.mediaConstructing = false; } Object.defineProperty(r, "_r", { value: list }); return r; };

  // ---------------------------------------------------------- canPlayType
  var SUPPORT = {
    "audio/mp4": /^(mp4a\.40\.(2|5|29)|mp4a\.67|mp4a\.69|mp4a\.6b|opus|flac)$/i,
    "audio/ogg": /^(opus|vorbis|flac)$/,
    "audio/wav": /^(1)$/, "audio/wave": /^(1)$/, "audio/x-wav": /^(1)$/,
    "audio/webm": /^(opus|vorbis)$/,
    "audio/mpeg": null, "audio/mp3": null, "audio/flac": null, "audio/aac": null, "audio/x-m4a": null,
    "video/mp4": /^(mp4a\.40\.(2|5|29)|avc1\.[0-9a-f]{6}|avc3\.[0-9a-f]{6}|vp09(\.\d\d){3,}|av01(\.[\w.]+)?|opus|flac)$/i,
    "video/ogg": /^(opus|vorbis|theora|flac)$/,
    "video/webm": /^(opus|vorbis|vp8|vp8\.0|vp9|vp9\.0|vp09(\.\d\d){3,}|av01(\.[\w.]+)?)$/,
  };
  __jb.canPlayType = function (type) {
    var s = String(type).trim();
    var semi = s.indexOf(";"), base = (semi < 0 ? s : s.slice(0, semi)).trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(SUPPORT, base)) return "";
    var params = semi < 0 ? "" : s.slice(semi + 1);
    var m = /(?:^|;)\s*codecs\s*=\s*(?:"([^"]*)"?|([^;]*))/i.exec(params);
    var codecs = m ? (m[1] !== undefined ? m[1] : m[2] || "").split(",").map(function (c) { return c.trim(); }).filter(Boolean) : [];
    if (!codecs.length) return "maybe";
    var re = SUPPORT[base];
    if (!re) return "";
    return codecs.every(function (c) { return re.test(c); }) ? "probably" : "";
  };

  // ---------------------------------------------------------- state
  var st = function (el) {
    if (!el._media) Object.defineProperty(el, "_media", { value: {
      networkState: NETWORK.EMPTY, readyState: HAVE.NOTHING, currentSrc: "", error: null, paused: true, ended: false, seeking: false,
      currentTime: 0, duration: NaN, playbackRate: 1, defaultPlaybackRate: 1, volume: 1, muted: null, played: [], seekable: [], buffered: [],
      videoWidth: 0, videoHeight: 0, pendingPlay: [], loadGen: 0, clock: null, lastTick: 0, autoplaying: true, preservesPitch: true,
      textTracks: null, audioTracks: null, videoTracks: null, defaultStart: 0, showPoster: true,
    }, writable: true });
    return el._media;
  };
  var fire = function (el, type) { __jb.fireUA(el, type); };
  var queue = function (el, fn) { var gen = st(el).loadGen; setTimeout(function () { if (st(el).loadGen === gen) fn(); }, 0); };
  var queueAlways = function (fn) { setTimeout(fn, 0); };
  var rejectPending = function (el, err) { var m = st(el), list = m.pendingPlay.splice(0); list.forEach(function (p) { p.reject(err); }); };
  var resolvePending = function (el) { var m = st(el), list = m.pendingPlay.splice(0); list.forEach(function (p) { p.resolve(undefined); }); };
  var stopClock = function (m) { if (m.clock) { clearInterval(m.clock); m.clock = null; } };
  var isVideo = function (el) { return el._tag === "video"; };

  // "Media element load algorithm"
  __jb.mediaLoad = function (el) {
    var m = st(el);
    if (m.mse) mseDetach(el);
    m.loadGen++;
    stopClock(m);
    // Abort a running resource selection; pending play promises are rejected with AbortError.
    if (m.networkState === NETWORK.LOADING || m.networkState === NETWORK.IDLE) queueAlways(function () { fire(el, "abort"); });
    if (m.networkState !== NETWORK.EMPTY) {
      queueAlways(function () { fire(el, "emptied"); });
      m.networkState = NETWORK.EMPTY;
      m.readyState = HAVE.NOTHING;
      if (!m.paused) { m.paused = true; var errA = __jb.domError("AbortError", "The play() request was interrupted by a new load request."); rejectPending(el, errA); }
      m.seeking = false;
      if (m.currentTime !== 0) { m.currentTime = 0; queueAlways(function () { fire(el, "timeupdate"); }); }
      m.duration = NaN; m.videoWidth = 0; m.videoHeight = 0; m.buffered = []; m.seekable = []; m.played = [];
    } else if (m.pendingPlay.length) {
      var err = __jb.domError("AbortError", "The play() request was interrupted by a new load request.");
      rejectPending(el, err);
    }
    m.playbackRate = m.defaultPlaybackRate;
    m.error = null; m.ended = false; m.autoplaying = true;
    selectResource(el);
  };
  function selectResource(el) {
    var m = st(el), gen = m.loadGen;
    m.networkState = NETWORK.NO_SOURCE;
    m.showPoster = true;
    // "await a stable state"
    Promise.resolve().then(function () {
      if (m.loadGen !== gen) return;
      var mode = null, child = null;
      if (el.hasAttribute("src")) mode = "attribute";
      else { for (var c = el.firstElementChild; c; c = c.nextElementSibling) if (c._tag === "source" && c._ns === __jb.HTML_NS) { mode = "children"; child = c; break; } }
      if (!mode) { m.networkState = NETWORK.EMPTY; return; }
      m.networkState = NETWORK.LOADING;
      queue(el, function () { fire(el, "loadstart"); });
      if (mode === "attribute") {
        var src = el.getAttribute("src");
        if (src === "") { failSource(el, gen); return; }
        var url = null; try { url = new URL(src, el.baseURI).href; } catch (e) { url = null; }
        if (url === null) { failSource(el, gen); return; }
        m.currentSrc = url;
        var msA = mseFor(url);
        if (msA) { mseAttach(el, msA, gen, function () { failSource(el, gen); }); return; }
        fetchResource(el, url, gen, function () { failSource(el, gen); });
        return;
      }
      tryChildren(el, child, gen);
    });
  }
  // "dedicated media source failure steps"
  function failSource(el, gen) {
    var m = st(el);
    if (m.loadGen !== gen) return;
    // State changes happen now; only the event (and promise rejection) is queued.
    m.error = mediaError(4, "MEDIA_ELEMENT_ERROR: Format error");
    m.networkState = NETWORK.NO_SOURCE;
    m.showPoster = true;
    queue(el, function () {
      fire(el, "error");
      rejectPending(el, __jb.domError("NotSupportedError", "The element has no supported sources."));
    });
  }
  function tryChildren(el, candidate, gen) {
    var m = st(el);
    var next = function (node) { for (var c = node ? node.nextElementSibling : null; c; c = c.nextElementSibling) if (c._tag === "source" && c._ns === __jb.HTML_NS) return c; return null; };
    var attempt = function (source) {
      if (m.loadGen !== gen) return;
      if (!source) { m.networkState = NETWORK.NO_SOURCE; m.waitingForSource = gen; return; } // waiting: a later <source> insertion resumes
      var failed = function () { queue(el, function () { fire(source, "error"); attempt(next(source)); }); };
      var src = source.getAttribute("src");
      if (src === null || src === "") { failed(); return; }
      var url; try { url = new URL(src, el.baseURI).href; } catch (e) { failed(); return; }
      var type = source.getAttribute("type");
      if (type !== null && __jb.canPlayType(type) === "") { failed(); return; }
      var media = source.getAttribute("media");
      if (media !== null && media.trim() && !__jb.evalMediaQuery(media)) { failed(); return; }
      m.currentSrc = url;
      var msC = mseFor(url);
      if (msC) { mseAttach(el, msC, gen, failed); return; }
      fetchResource(el, url, gen, failed);
    };
    attempt(candidate);
  }
  __jb.mediaSourceInserted = function (el) {
    var m = st(el);
    if (m.networkState === NETWORK.EMPTY) { if (!el.hasAttribute("src")) selectResource(el); return; }
    if (m.networkState === NETWORK.NO_SOURCE && m.waitingForSource === m.loadGen && !m.error) {
      m.waitingForSource = null; m.networkState = NETWORK.LOADING;
      var gen = m.loadGen, src = null;
      for (var c = el.lastElementChild; c; c = c.previousElementSibling) if (c._tag === "source") { src = c; break; }
      tryChildren(el, src, gen);
    }
  };
  function fetchResource(el, url, gen, onFail) {
    var m = st(el);
    if (el.getAttribute("preload") === "none" && !el.hasAttribute("autoplay") && !m.forceLoad) {
      queue(el, function () { m.networkState = NETWORK.IDLE; fire(el, "suspend"); m.suspendedUrl = { url: url, fail: onFail }; });
      return;
    }
    var withInfo = withInfoFor(el, gen);
    setTimeout(function () {
      if (m.loadGen !== gen) return;
      // mixed content (insecure media is upgraded) and CSP media-src
      var mdest = el._tag === "video" ? "video" : "audio";
      var mf = __jb.mixed ? __jb.mixed.filter(mdest, url) : { url: url };
      if (mf.blocked || (__jb.csp && !__jb.csp.allowsRequest(mdest, url, { element: el }))) { onFail(); return; }
      var co = el.getAttribute("crossorigin");
      var mmode = co === null ? "no-cors" : "cors", mcred = co === null || /^use-credentials$/i.test(co) ? "include" : "same-origin";
      var probe = function (u) { try { return __jb.native("media", { url: u, dest: mdest, mode: mmode, initiator: __jb.fetchInitiator(), mixed: mf.mode, csp: __jb.csp ? __jb.csp.redirectLists(mdest) : null }); } catch (e) { return null; } };
      // a controlled document's media goes to its service worker first (its response type
      // decides canvas tainting)
      var swc = __jb.sw && /^https?:/.test(mf.url) ? __jb.sw.controllerForRequest(mf.url) : null;
      var network = function () {
        el._swMedia = null;
        var crossOrigin = false;
        try { crossOrigin = /^https?:/.test(mf.url) && new URL(mf.url).origin !== location.origin; } catch (eo) {}
        if (mmode === "cors" && crossOrigin && typeof __jb.corsFetchRaw === "function") {
          // CORS: the media response must allow this origin
          var creq; try { creq = new Request(mf.url, { mode: "cors", credentials: mcred }); } catch (er) { onFail(); return; }
          try { __jb.corsFetchRaw(creq, null, false, null, mdest); } catch (ec) { onFail(); return; }
          var i2 = probe(mf.url);
          if (!i2 || !i2.ok) { onFail(); return; }
          withInfo(i2);
          return;
        }
        var i1 = probe(mf.url);
        if (!i1 || !i1.ok) { onFail(); return; }
        withInfo(i1);
      };
      if (swc) {
        __jb.sw.handleFetch(swc, { url: mf.url, method: "GET", headers: {}, mode: mmode, destination: mdest, credentials: mcred, redirect: "follow" }, globalThis, "").then(function (rec) {
          if (m.loadGen !== gen) return;
          if (rec === false) { onFail(); return; }
          if (!rec) { network(); return; }
          if (rec.status >= 400) { onFail(); return; }
          el._swMedia = { type: rec.type };
          var ct = ((rec.headers && rec.headers["content-type"]) || "application/octet-stream").split(";")[0];
          var i3 = probe("data:" + ct + ";base64," + __jb.bytesToB64(new Uint8Array(rec.body || [])));
          if (!i3 || !i3.ok) { onFail(); return; }
          withInfo(i3);
        });
        return;
      }
      network();
    }, 0);
  }
  function withInfoFor(el, gen) {
    var m = st(el);
    return function (info) {
      if (m.loadGen !== gen) return;
      if (info.video && !isVideo(el) && !info.audio) { /* audio element with video-only media still plays */ }
      // Metadata
      m.duration = typeof info.duration === "number" && isFinite(info.duration) ? info.duration : Infinity;
      m.seekable = isFinite(m.duration) ? [[0, m.duration]] : [];
      if (isVideo(el) && info.video) { m.videoWidth = info.width || 0; m.videoHeight = info.height || 0; }
      m.hasVideo = !!info.video; m.hasAudio = !!info.audio;
      if (m.defaultStart && isFinite(m.duration)) m.currentTime = Math.min(m.defaultStart, m.duration);
      fire(el, "durationchange");
      if (isVideo(el) && m.videoWidth) fire(el, "resize");
      m.readyState = HAVE.METADATA;
      fire(el, "loadedmetadata");
      if (m.loadGen !== gen) return;
      m.readyState = HAVE.CURRENT_DATA;
      fire(el, "loadeddata");
      if (m.loadGen !== gen) return;
      m.buffered = isFinite(m.duration) ? [[0, m.duration]] : [];
      setReady(el, HAVE.ENOUGH_DATA);
      fire(el, "progress");
      m.networkState = NETWORK.IDLE;
      fire(el, "suspend");
    };
  }
  function setReady(el, state) {
    var m = st(el), was = m.readyState;
    m.readyState = state;
    if (was < HAVE.FUTURE_DATA && state >= HAVE.FUTURE_DATA) {
      fire(el, "canplay");
      if (!m.paused) notifyPlaying(el);
      else if (m.autoplaying && el.hasAttribute("autoplay") && __jb.mediaAutoplayAllowed(el)) {
        m.paused = false; m.showPoster = false;
        fire(el, "play");
        notifyPlaying(el);
        startClock(el);
      }
    }
    if (was < HAVE.ENOUGH_DATA && state === HAVE.ENOUGH_DATA) fire(el, "canplaythrough");
  }
  __jb.mediaAutoplayAllowed = function (el) { return el.muted || st(el).volume === 0 || __jb.userActivationActive === true || true; };
  function notifyPlaying(el) { fire(el, "playing"); resolvePending(el); }
  function startClock(el) {
    var m = st(el);
    stopClock(m);
    m.lastTick = performance.now();
    m.clock = setInterval(function () { tick(el); }, 250);
  }
  function tick(el) {
    var m = st(el);
    if (m.paused || m.readyState < HAVE.FUTURE_DATA) { stopClock(m); return; }
    var now = performance.now(), dt = (now - m.lastTick) / 1000; m.lastTick = now;
    var before = m.currentTime;
    m.currentTime += dt * m.playbackRate;
    if (m.mse && m.playbackRate >= 0 && mseStall(el, m, before)) return;
    if (m.playbackRate >= 0 && isFinite(m.duration) && m.currentTime >= m.duration) {
      if (el.hasAttribute("loop")) { m.currentTime = 0; fire(el, "timeupdate"); return; }
      m.currentTime = m.duration;
      stopClock(m);
      m.ended = true;
      fire(el, "timeupdate");
      if (!m.paused) { m.paused = true; fire(el, "pause"); rejectPending(el, __jb.domError("AbortError", "The media ended.")); }
      fire(el, "ended");
      return;
    }
    if (m.playbackRate < 0 && m.currentTime <= 0) { m.currentTime = 0; stopClock(m); fire(el, "timeupdate"); return; }
    fire(el, "timeupdate");
  }
  var endedPlayback = function (m, el) { return isFinite(m.duration) && m.readyState >= HAVE.METADATA && m.currentTime >= m.duration && m.playbackRate >= 0 && !el.hasAttribute("loop"); };
  __jb.mediaPlay = function (el) {
    var m = st(el);
    return new Promise(function (resolve, reject) {
      if (m.error && m.error.code === 4) { reject(__jb.domError("NotSupportedError", "The element has no supported sources.")); return; }
      m.pendingPlay.push({ resolve: resolve, reject: reject });
      if (m.networkState === NETWORK.EMPTY) selectResource(el);
      if (m.suspendedUrl) { var s = m.suspendedUrl; m.suspendedUrl = null; m.forceLoad = true; m.networkState = NETWORK.LOADING; fetchResource(el, s.url, m.loadGen, s.fail); }
      if (endedPlayback(m, el)) seek(el, 0);
      if (m.paused) {
        m.paused = false; m.showPoster = false; m.ended = false;
        queueAlways(function () { fire(el, "play"); });
        if (m.readyState <= HAVE.CURRENT_DATA) queueAlways(function () { fire(el, "waiting"); });
        else queueAlways(function () { if (!m.paused) notifyPlaying(el); });
        if (m.readyState >= HAVE.FUTURE_DATA) startClock(el);
      } else if (m.readyState >= HAVE.FUTURE_DATA) queueAlways(function () { resolvePending(el); });
      m.autoplaying = false;
    });
  };
  __jb.mediaPause = function (el) {
    var m = st(el);
    if (m.networkState === NETWORK.EMPTY) selectResource(el);
    m.autoplaying = false;
    if (!m.paused) {
      m.paused = true;
      stopClock(m);
      var err = __jb.domError("AbortError", "The play() request was interrupted by a call to pause().");
      queueAlways(function () { fire(el, "timeupdate"); fire(el, "pause"); rejectPending(el, err); });
    }
  };
  function seek(el, t) {
    var m = st(el);
    if (m.readyState === HAVE.NOTHING) { m.defaultStart = t; return; }
    m.seeking = true;
    if (isFinite(m.duration) && t > m.duration) t = m.duration;
    if (t < 0) t = 0;
    m.currentTime = t; m.ended = false;
    m.lastTick = performance.now();
    if (m.mse) mseRefresh(m.mse);
    queueAlways(function () { fire(el, "seeking"); m.seeking = false; fire(el, "timeupdate"); fire(el, "seeked"); });
  }

  // ---------------------------------------------------------- IDL
  var P = M.prototype;
  var def = function (name, get, set) { Object.defineProperty(P, name, { get: get, set: set, enumerable: true, configurable: true }); };
  def("networkState", function () { return st(this).networkState; });
  def("readyState", function () { return st(this).readyState; });
  def("currentSrc", function () { return st(this).currentSrc; });
  def("error", function () { return st(this).error; });
  def("paused", function () { return st(this).paused; });
  def("ended", function () { var m = st(this); return endedPlayback(m, this); });
  def("seeking", function () { return st(this).seeking; });
  def("duration", function () { return st(this).duration; });
  def("currentTime", function () { var m = st(this); return m.readyState === HAVE.NOTHING ? m.defaultStart : m.currentTime; }, function (v) { v = +v; if (!isFinite(v)) throw new TypeError("Failed to set the 'currentTime' property on 'HTMLMediaElement': The provided double value is non-finite."); seek(this, v); });
  def("buffered", function () { return ranges(st(this).buffered.slice()); });
  def("seekable", function () { return ranges(st(this).seekable.slice()); });
  def("played", function () { var m = st(this); return ranges(m.currentTime > 0 ? [[0, m.currentTime]] : []); });
  def("defaultPlaybackRate", function () { return st(this).defaultPlaybackRate; }, function (v) { v = +v; if (!isFinite(v)) throw new TypeError("The provided double value is non-finite."); var m = st(this), el = this; if (m.defaultPlaybackRate === v) return; m.defaultPlaybackRate = v; queueAlways(function () { fire(el, "ratechange"); }); });
  def("playbackRate", function () { return st(this).playbackRate; }, function (v) { v = +v; if (!isFinite(v)) throw new TypeError("The provided double value is non-finite."); if (v !== 0 && (Math.abs(v) < 0.0625 || Math.abs(v) > 16)) throw __jb.domError("NotSupportedError", "The provided playback rate (" + v + ") is not in the supported playback range."); var m = st(this), el = this; if (m.playbackRate === v) return; m.playbackRate = v; queueAlways(function () { fire(el, "ratechange"); }); });
  def("preservesPitch", function () { return st(this).preservesPitch; }, function (v) { st(this).preservesPitch = !!v; });
  def("volume", function () { return st(this).volume; }, function (v) { v = +v; if (!isFinite(v)) throw new TypeError("Failed to set the 'volume' property on 'HTMLMediaElement': The provided double value is non-finite."); if (v < 0 || v > 1) throw __jb.domError("IndexSizeError", "The volume provided (" + v + ") is outside the range [0, 1]."); var m = st(this), el = this; if (m.volume === v) return; m.volume = v; queueAlways(function () { fire(el, "volumechange"); }); });
  def("muted", function () { var m = st(this); return m.muted === null ? this.hasAttribute("muted") : m.muted; }, function (v) { v = !!v; var m = st(this), el = this, cur = m.muted === null ? this.hasAttribute("muted") : m.muted; m.muted = v; if (cur === v) return; queueAlways(function () { fire(el, "volumechange"); }); });
  def("defaultMuted", function () { return this.hasAttribute("muted"); }, function (v) { this.toggleAttribute("muted", !!v); });
  ["autoplay", "loop", "controls"].forEach(function (n) { def(n, function () { return this.hasAttribute(n); }, function (v) { this.toggleAttribute(n, !!v); }); });
  def("src", function () { var v = this.getAttribute("src"); if (v === null) return ""; try { return new URL(v, this.baseURI).href; } catch (e) { return v; } }, function (v) { this.setAttribute("src", String(v)); });
  def("preload", function () { var v = (this.getAttribute("preload") || "").toLowerCase(); if (this.getAttribute("preload") === null) return "metadata"; return v === "none" || v === "metadata" ? v : "auto"; }, function (v) { this.setAttribute("preload", String(v)); });
  def("crossOrigin", function () { var v = this.getAttribute("crossorigin"); if (v === null) return null; return v.toLowerCase() === "use-credentials" ? "use-credentials" : "anonymous"; }, function (v) { if (v === null || v === undefined) this.removeAttribute("crossorigin"); else this.setAttribute("crossorigin", String(v)); });
  def("srcObject", function () { return st(this).srcObject || null; }, function (v) { st(this).srcObject = v; __jb.mediaLoad(this); });
  def("disableRemotePlayback", function () { return this.hasAttribute("disableremoteplayback"); }, function (v) { this.toggleAttribute("disableremoteplayback", !!v); });
  def("textTracks", function () { return textTrackList(this); });
  def("audioTracks", function () { return st(this).audioTracks || (st(this).audioTracks = trackList(AudioTrackList)); });
  def("videoTracks", function () { return st(this).videoTracks || (st(this).videoTracks = trackList(VideoTrackList)); });
  var methods = {
    load: function load() { __jb.mediaLoad(this); },
    canPlayType: function canPlayType(type) { if (arguments.length < 1) throw new TypeError("Failed to execute 'canPlayType': 1 argument required."); return __jb.canPlayType(type); },
    play: function play() { return __jb.mediaPlay(this); },
    pause: function pause() { __jb.mediaPause(this); },
    fastSeek: function fastSeek(t) { t = +t; if (!isFinite(t)) throw new TypeError("The provided double value is non-finite."); seek(this, t); },
    getStartDate: function getStartDate() { return new Date(NaN); },
    addTextTrack: function addTextTrack(kind, label, language) {
      kind = String(kind);
      if (!/^(subtitles|captions|descriptions|chapters|metadata)$/.test(kind)) throw new TypeError("The provided value '" + kind + "' is not a valid enum value of type TextTrackKind.");
      var t = newTextTrack(kind, label === undefined ? "" : String(label), language === undefined ? "" : String(language), "", "hidden", this);
      addToList(textTrackList(this), t);
      return t;
    },
    setSinkId: function setSinkId() { return Promise.resolve(); },
  };
  Object.keys(methods).forEach(function (k) { Object.defineProperty(P, k, { value: methods[k], writable: true, enumerable: true, configurable: true }); });
  ["play", "pause", "load", "canPlayType"].forEach(function (k) { if (Object.prototype.hasOwnProperty.call(HTMLElement.prototype, k)) delete HTMLElement.prototype[k]; });
  var V = __jb.htmlClasses.HTMLVideoElement;
  if (V) {
    var vdef = function (name, get, set) { Object.defineProperty(V.prototype, name, { get: get, set: set, enumerable: true, configurable: true }); };
    vdef("videoWidth", function () { return st(this).readyState >= HAVE.METADATA ? st(this).videoWidth : 0; });
    vdef("videoHeight", function () { return st(this).readyState >= HAVE.METADATA ? st(this).videoHeight : 0; });
    vdef("poster", function () { var v = this.getAttribute("poster"); if (v === null) return ""; try { return new URL(v, this.baseURI).href; } catch (e) { return v; } }, function (v) { this.setAttribute("poster", String(v)); });
    vdef("playsInline", function () { return this.hasAttribute("playsinline"); }, function (v) { this.toggleAttribute("playsinline", !!v); });
    [["width", 0], ["height", 0]].forEach(function (p) { vdef(p[0], function () { var v = __jb.parseHtmlNonneg(this.getAttribute(p[0]) || ""); return v === null || v > __jb.MAX_INT ? 0 : v; }, function (v) { this.setAttribute(p[0], String(__jb.toUint32(v))); }); });
    Object.defineProperty(V.prototype, "getVideoPlaybackQuality", { value: function getVideoPlaybackQuality() { return { creationTime: performance.now(), droppedVideoFrames: 0, totalVideoFrames: 0, corruptedVideoFrames: 0 }; }, writable: true, enumerable: true, configurable: true });
    Object.defineProperty(V.prototype, "requestVideoFrameCallback", { value: function requestVideoFrameCallback(cb) { return 0; }, writable: true, enumerable: true, configurable: true });
    Object.defineProperty(V.prototype, "cancelVideoFrameCallback", { value: function cancelVideoFrameCallback() {}, writable: true, enumerable: true, configurable: true });
  }
  // Legacy factory function Audio(src)
  var A = __jb.htmlClasses.HTMLAudioElement;
  if (A) {
    var Audio = function Audio(src) {
      if (!new.target) throw new TypeError("Class constructor Audio cannot be invoked without 'new'");
      var el = __jb.currentDocument.createElement("audio");
      el.setAttribute("preload", "auto");
      if (src !== undefined) el.setAttribute("src", String(src));
      return el;
    };
    Audio.prototype = A.prototype;
    globalThis.Audio = Audio;
  }

  // src changes and <source> insertion drive the load algorithm.
  var baseAttrChanged = __jb.attributeChanged;
  __jb.attributeChanged = function (el, attr, oldValue, newValue) {
    baseAttrChanged(el, attr, oldValue, newValue);
    if (attr._ns === null && attr._local === "src" && newValue !== null && (el._tag === "video" || el._tag === "audio") && el._ns === __jb.HTML_NS) __jb.mediaLoad(el);
    if (attr._ns === null && attr._local === "src" && newValue !== null && el._tag === "track" && el._ns === __jb.HTML_NS) trackSrcChanged(el);
  };
  // Insertion steps of <source>/<track> children (connected or not).
  var baseInsert = __jb.insert;
  __jb.insert = function (parent, node, child, suppressObservers) {
    var nodes = node.nodeType === 11 ? __jb.arrayFrom(node.childNodes) : [node];
    baseInsert(parent, node, child, suppressObservers);
    if (parent.nodeType !== 1 || parent._ns !== __jb.HTML_NS || (parent._tag !== "video" && parent._tag !== "audio")) return;
    nodes.forEach(function (n) {
      if (n.nodeType !== 1 || n.parentNode !== parent || n._ns !== __jb.HTML_NS) return;
      if (n._tag === "source") __jb.mediaSourceInserted(parent);
      else if (n._tag === "track") trackInserted(n, parent);
    });
  };
  // Initial markup: media elements with a src or <source> start loading once the document has them.
  __jb.initMedia = function () {
    __jb.descendants(__jb.currentDocument, function (n) { return n.nodeType === 1 && (n._tag === "video" || n._tag === "audio") && n._ns === __jb.HTML_NS; }).forEach(function (el) {
      if (st(el).networkState === NETWORK.EMPTY && (el.hasAttribute("src") || el.querySelector("source"))) selectResource(el);
      el.querySelectorAll("track").forEach(function (t) { trackInserted(t, el); });
    });
  };

  // ---------------------------------------------------------- text tracks
  class TextTrackList extends EventTarget {
    constructor() { if (!__jb.mediaConstructing) throw new TypeError("Illegal constructor"); super(); }
    get length() { return this._items.length; }
    getTrackById(id) { id = String(id); for (var i = 0; i < this._items.length; i++) if (this._items[i].id === id) return this._items[i]; return null; }
  }
  class AudioTrackList extends EventTarget { constructor() { if (!__jb.mediaConstructing) throw new TypeError("Illegal constructor"); super(); } get length() { return this._items.length; } getTrackById(id) { return null; } }
  class VideoTrackList extends EventTarget { constructor() { if (!__jb.mediaConstructing) throw new TypeError("Illegal constructor"); super(); } get length() { return this._items.length; } get selectedIndex() { return -1; } getTrackById(id) { return null; } }
  [TextTrackList, AudioTrackList, VideoTrackList].forEach(function (C) {
    __jb.setTag(C, C.name); __jb.defineEventHandlerProps(C.prototype, ["change", "addtrack", "removetrack"]);
    // indexed getter: iterable like an array ([...video.textTracks], for..of)
    Object.defineProperty(C.prototype, Symbol.iterator, { value: function values() { return (this._items || []).slice()[Symbol.iterator](); }, writable: true, configurable: true });
  });
  var listProxy = function (list) {
    return new Proxy(list, {
      get: function (t, k) { if (typeof k === "string" && /^\d+$/.test(k)) return t._items[Number(k)]; var v = Reflect.get(t, k, t); return typeof v === "function" && k !== "constructor" ? v.bind(t) : v; },
      has: function (t, k) { if (typeof k === "string" && /^\d+$/.test(k)) return Number(k) < t._items.length; return k in t; },
      set: function (t, k, v) { if (typeof k === "string" && /^\d+$/.test(k)) return false; t[k] = v; return true; },
      ownKeys: function (t) { return t._items.map(function (_, i) { return String(i); }).concat(Reflect.ownKeys(t)); },
      getOwnPropertyDescriptor: function (t, k) { if (typeof k === "string" && /^\d+$/.test(k)) { var v = t._items[Number(k)]; return v ? { value: v, enumerable: true, configurable: true, writable: false } : undefined; } return Reflect.getOwnPropertyDescriptor(t, k); },
    });
  };
  var trackList = function (C) { __jb.mediaConstructing = true; try { var l = new C(); } finally { __jb.mediaConstructing = false; } Object.defineProperty(l, "_items", { value: [] }); return listProxy(l); };
  var textTrackList = function (el) { var m = st(el); if (!m.textTracks) m.textTracks = trackList(TextTrackList); return m.textTracks; };
  var addToList = function (list, track) {
    list._items.push(track);
    queueAlways(function () { var ev = new TrackEvent("addtrack", { track: track }); __jb.setTrusted(ev, true); ev._trustedDispatch = true; list.dispatchEvent(ev); });
  };
  class TrackEvent extends Event { constructor(type, init) { super(type, init); var t = init && init.track; if (t !== undefined && t !== null && !(t instanceof TextTrack)) throw new TypeError("Failed to construct 'TrackEvent': member track is not of a valid track type."); Object.defineProperty(this, "_track", { value: t || null }); } get track() { return this._track; } }
  __jb.setTag(TrackEvent, "TrackEvent");

  class TextTrack extends EventTarget {
    constructor() { if (!__jb.mediaConstructing) throw new TypeError("Illegal constructor"); super(); }
    get kind() { return this._kind; } get label() { return this._label; } get language() { return this._language; } get id() { return this._id; }
    get inBandMetadataTrackDispatchType() { return ""; }
    get mode() { return this._mode; }
    set mode(v) {
      v = String(v);
      if (!/^(disabled|hidden|showing)$/.test(v) || v === this._mode) return;
      this._mode = v;
      var self = this;
      if (this._el && v !== "disabled") startTrackLoad(this._el);
      if (this._media) queueAlways(function () { var l = textTrackList(self._media); var ev = new Event("change"); __jb.setTrusted(ev, true); ev._trustedDispatch = true; l.dispatchEvent(ev); });
    }
    get cues() { return this._mode === "disabled" ? null : this._cuesList; }
    get activeCues() { if (this._mode === "disabled") return null; var t = this._media ? this._media.currentTime : 0; return cueList(this._cues.filter(function (c) { return c.startTime <= t && t < c.endTime; })); }
    addCue(cue) {
      if (!(cue instanceof TextTrackCue)) throw new TypeError("Failed to execute 'addCue' on 'TextTrack': parameter 1 is not of type 'TextTrackCue'.");
      if (cue._track) cue._track.removeCue(cue);
      cue._track = this;
      if (cue._seq !== undefined) cue._seq = undefined;
      insertCue(this._cues, cue);
    }
    removeCue(cue) {
      if (!(cue instanceof TextTrackCue)) throw new TypeError("Failed to execute 'removeCue' on 'TextTrack': parameter 1 is not of type 'TextTrackCue'.");
      var i = this._cues.indexOf(cue);
      if (i < 0) throw __jb.domError("NotFoundError", "The specified cue is not listed in the TextTrack's list of cues.");
      this._cues.splice(i, 1); cue._track = null;
    }
  }
  __jb.setTag(TextTrack, "TextTrack");
  __jb.defineEventHandlerProps(TextTrack.prototype, ["cuechange"]);
  var resortCue = function (cue) { var t = cue._track; if (!t) return; var i = t._cues.indexOf(cue); if (i < 0) return; t._cues.splice(i, 1); insertCue(t._cues, cue); };
  // text track cue order: start time, then later end time first, then the order cues were added
  var cueSeq = 0;
  var insertCue = function (list, cue) {
    if (cue._seq === undefined) Object.defineProperty(cue, "_seq", { value: ++cueSeq, writable: true });
    var after = function (a, b) { return a.startTime > b.startTime || (a.startTime === b.startTime && (a.endTime < b.endTime || (a.endTime === b.endTime && a._seq > b._seq))); };
    var i = list.length; while (i > 0 && after(list[i - 1], cue)) i--; list.splice(i, 0, cue);
  };
  class TextTrackCueList {
    constructor() { if (!__jb.mediaConstructing) throw new TypeError("Illegal constructor"); }
    get length() { return this._items().length; }
    getCueById(id) { id = String(id); var l = this._items(); for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i]; return null; }
  }
  __jb.setTag(TextTrackCueList, "TextTrackCueList");
  var cueList = function (arrOrFn) {
    __jb.mediaConstructing = true; try { var l = new TextTrackCueList(); } finally { __jb.mediaConstructing = false; }
    Object.defineProperty(l, "_items", { value: typeof arrOrFn === "function" ? arrOrFn : function () { return arrOrFn; } });
    return new Proxy(l, {
      get: function (t, k) { if (typeof k === "string" && /^\d+$/.test(k)) return t._items()[Number(k)]; var v = Reflect.get(t, k, t); return typeof v === "function" && k !== "constructor" ? v.bind(t) : v; },
      has: function (t, k) { if (typeof k === "string" && /^\d+$/.test(k)) return Number(k) < t._items().length; return k in t; },
    });
  };
  var newTextTrack = function (kind, label, language, id, mode, media) {
    __jb.mediaConstructing = true; try { var t = new TextTrack(); } finally { __jb.mediaConstructing = false; }
    var props = { _kind: kind, _label: label, _language: language, _id: id, _mode: mode, _media: media || null, _el: null, _cues: [] };
    Object.keys(props).forEach(function (k) { Object.defineProperty(t, k, { value: props[k], writable: true }); });
    Object.defineProperty(t, "_cuesList", { value: cueList(function () { return t._cues; }) });
    return t;
  };
  class TextTrackCue extends EventTarget {
    constructor() { if (!__jb.mediaConstructing) throw new TypeError("Illegal constructor"); super(); }
    get track() { return this._track || null; }
    get id() { return this._id; } set id(v) { this._id = String(v); }
    get startTime() { return this._start; } set startTime(v) { v = +v; if (!isFinite(v)) throw new TypeError("The provided double value is non-finite."); if (v === this._start) return; this._start = v; resortCue(this); }
    get endTime() { return this._end; } set endTime(v) { v = +v; if (v !== v) throw new TypeError("The provided double value is non-finite."); if (v === this._end) return; this._end = v; resortCue(this); }
    get pauseOnExit() { return this._pause; } set pauseOnExit(v) { this._pause = !!v; }
  }
  __jb.setTag(TextTrackCue, "TextTrackCue");
  __jb.defineEventHandlerProps(TextTrackCue.prototype, ["enter", "exit"]);
  class VTTCue extends TextTrackCue {
    constructor(startTime, endTime, text) {
      if (arguments.length < 3) throw new TypeError("Failed to construct 'VTTCue': 3 arguments required.");
      __jb.mediaConstructing = true; try { super(); } finally { __jb.mediaConstructing = false; }
      startTime = +startTime; endTime = +endTime;
      if (!isFinite(startTime)) throw new TypeError("Failed to construct 'VTTCue': The provided double value is non-finite.");
      if (endTime !== endTime) throw new TypeError("Failed to construct 'VTTCue': The provided double value is non-finite.");
      var props = { _track: null, _id: "", _start: startTime, _end: endTime, _pause: false, _text: String(text), _vertical: "", _snap: true, _line: "auto", _lineAlign: "start", _position: "auto", _positionAlign: "auto", _size: 100, _align: "center", _region: null };
      var self = this; Object.keys(props).forEach(function (k) { Object.defineProperty(self, k, { value: props[k], writable: true }); });
    }
    get text() { return this._text; } set text(v) { this._text = String(v); }
    get vertical() { return this._vertical; } set vertical(v) { v = String(v); if (/^(|rl|lr)$/.test(v)) this._vertical = v; }
    get snapToLines() { return this._snap; } set snapToLines(v) { this._snap = !!v; }
    get line() { return this._line; } set line(v) { if (v === "auto") { this._line = "auto"; return; } v = +v; if (!isFinite(v)) throw new TypeError("The provided double value is non-finite."); this._line = v; }
    get lineAlign() { return this._lineAlign; } set lineAlign(v) { v = String(v); if (/^(start|center|end)$/.test(v)) this._lineAlign = v; }
    get position() { return this._position; } set position(v) { if (v === "auto") { this._position = "auto"; return; } v = +v; if (!isFinite(v)) throw new TypeError("The provided double value is non-finite."); if (v < 0 || v > 100) throw __jb.domError("IndexSizeError", "The provided value is outside the range [0, 100]."); this._position = v; }
    get positionAlign() { return this._positionAlign; } set positionAlign(v) { v = String(v); if (/^(line-left|center|line-right|auto)$/.test(v)) this._positionAlign = v; }
    get size() { return this._size; } set size(v) { v = +v; if (!isFinite(v)) throw new TypeError("The provided double value is non-finite."); if (v < 0 || v > 100) throw __jb.domError("IndexSizeError", "The provided value is outside the range [0, 100]."); this._size = v; }
    get align() { return this._align; } set align(v) { v = String(v); if (/^(start|center|end|left|right)$/.test(v)) this._align = v; }
    get region() { return this._region; } set region(v) { this._region = v; }
    getCueAsHTML() { return __jb.vttCueToHTML(__jb.parseVttCueText(this._text)); }
  }
  __jb.setTag(VTTCue, "VTTCue");

  // WebVTT "cue text parsing rules": a tree of { t: "text"|"ts"|tag, ... } nodes.
  __jb.parseVttCueText = function (input) {
    var root = { t: "root", kids: [] }, cur = root, stack = [root], pos = 0, n = input.length;
    // each text token (the run between tags) is its own text node
    var run = null;
    var addText = function (s) { if (!s) return; if (run) run.v += s; else { run = { t: "text", v: s }; cur.kids.push(run); } };
    var decodeRef = function () {
      // at '&': HTML character reference (named or numeric)
      var m = /^&(#[0-9]+;|#[xX][0-9a-fA-F]+;|[A-Za-z][A-Za-z0-9]*;?)/.exec(input.slice(pos));
      if (!m) { pos++; return "&"; }
      var body = m[1];
      if (body.charAt(0) === "#") { var code = body.charAt(1) === "x" || body.charAt(1) === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10); pos += m[0].length; return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "\ufffd"; }
      var simple = { "amp;": "&", "lt;": "<", "gt;": ">", "lrm;": "\u200e", "rlm;": "\u200f", "nbsp;": "\u00a0", "quot;": '"', "apos;": "'" }[body];
      if (simple) { pos += m[0].length; return simple; }
      if (body.charAt(body.length - 1) === ";" && typeof __jb.htmlNamedReference === "function") { var r = __jb.htmlNamedReference(body.slice(0, -1)); if (r) { pos += m[0].length; return r; } }
      pos++; return "&";
    };
    var TAGS = { c: 1, i: 1, b: 1, u: 1, ruby: 1, rt: 1, v: 1, lang: 1 };
    while (pos < n) {
      var ch = input.charAt(pos);
      if (ch === "&") { addText(decodeRef()); continue; }
      if (ch !== "<") { var nxt = input.slice(pos).search(/[&<]/); var chunk = nxt < 0 ? input.slice(pos) : input.slice(pos, pos + nxt); addText(chunk); pos += chunk.length; continue; }
      // a tag: up to '>' (or the end of the input)
      run = null;
      var close = input.indexOf(">", pos), raw = close < 0 ? input.slice(pos + 1) : input.slice(pos + 1, close);
      pos = close < 0 ? n : close + 1;
      if (raw.charAt(0) === "/") {
        var endName = raw.slice(1).split(/[\s.]/)[0];
        if (cur.t === endName) { stack.pop(); cur = stack[stack.length - 1]; }
        else if (endName === "ruby" && cur.t === "rt") { stack.pop(); stack.pop(); cur = stack[stack.length - 1]; }
        continue;
      }
      if (/^[0-9]/.test(raw)) { if (/^(\d{2,}:)?\d{2}:\d{2}\.\d{3}$/.test(raw)) cur.kids.push({ t: "ts", v: raw }); continue; }
      var ws = raw.search(/[\t\n\f\r ]/), head = ws < 0 ? raw : raw.slice(0, ws), annotation = ws < 0 ? "" : raw.slice(ws + 1).replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "").replace(/[\t\n\f\r ]+/g, " ");
      var parts = head.split("."), name = parts.shift(), classes = parts.filter(function (c) { return c !== ""; });
      if (!TAGS[name] || (name === "rt" && cur.t !== "ruby")) continue;
      var node = { t: name, kids: [], classes: classes };
      if (name === "v") node.voice = annotation;
      if (name === "lang") node.lang = annotation;
      cur.kids.push(node); stack.push(node); cur = node;
    }
    return root;
  };
  __jb.vttCueToHTML = function (tree) {
    var f = __jb.currentDocument.createDocumentFragment();
    if (!tree.kids.length) { f.appendChild(__jb.currentDocument.createTextNode("")); return f; }
    (function build(parent, node) {
      node.kids.forEach(function (k) {
        if (k.t === "text") { parent.appendChild(__jb.currentDocument.createTextNode(k.v)); return; }
        if (k.t === "ts") { parent.appendChild(__jb.currentDocument.createProcessingInstruction("timestamp", k.v)); return; }
        var tag = k.t === "c" || k.t === "v" || k.t === "lang" ? "span" : k.t;
        var el = __jb.currentDocument.createElement(tag);
        if (k.classes.length) el.setAttribute("class", k.classes.join(" "));
        if (k.t === "v") el.setAttribute("title", k.voice);
        if (k.t === "lang") el.setAttribute("lang", k.lang);
        parent.appendChild(el);
        build(el, k);
      });
    })(f, tree);
    return f;
  };

  // <track>
  var TR = __jb.htmlClasses.HTMLTrackElement;
  if (TR) {
    defineConsts(TR, { NONE: 0, LOADING: 1, LOADED: 2, ERROR: 3 }, "");
    var tdef = function (name, get, set) { Object.defineProperty(TR.prototype, name, { get: get, set: set, enumerable: true, configurable: true }); };
    var trackOf = function (el) {
      if (!el._textTrack) {
        var k = trackKind(el);
        var t = newTextTrack(k, el.getAttribute("label") || "", el.getAttribute("srclang") || "", el.getAttribute("id") || "", "disabled", null);
        t._el = el;
        Object.defineProperty(el, "_textTrack", { value: t, writable: true });
        Object.defineProperty(el, "_trackReady", { value: 0, writable: true });
      }
      return el._textTrack;
    };
    var trackKind = function (el) { var k = (el.getAttribute("kind") || "").toLowerCase(); if (el.getAttribute("kind") === null) return "subtitles"; return /^(subtitles|captions|descriptions|chapters|metadata)$/.test(k) ? k : "metadata"; };
    tdef("track", function () { return trackOf(this); });
    tdef("readyState", function () { trackOf(this); return this._trackReady; });
    tdef("kind", function () { return trackKind(this); }, function (v) { this.setAttribute("kind", String(v)); });
    tdef("src", function () { var v = this.getAttribute("src"); if (v === null) return ""; try { return new URL(v, this.baseURI).href; } catch (e) { return v; } }, function (v) { this.setAttribute("src", String(v)); });
    tdef("srclang", function () { return this.getAttribute("srclang") || ""; }, function (v) { this.setAttribute("srclang", String(v)); });
    tdef("label", function () { return this.getAttribute("label") || ""; }, function (v) { this.setAttribute("label", String(v)); });
    tdef("default", function () { return this.hasAttribute("default"); }, function (v) { this.toggleAttribute("default", !!v); });
    var baseAttr2 = __jb.attributeChanged;
    __jb.attributeChanged = function (el, attr, oldValue, newValue) {
      baseAttr2(el, attr, oldValue, newValue);
      if (el._tag === "track" && el._textTrack && attr._ns === null) {
        if (attr._local === "kind") el._textTrack._kind = trackKind(el);
        if (attr._local === "label") el._textTrack._label = newValue || "";
        if (attr._local === "srclang") el._textTrack._language = newValue || "";
      }
    };
  }
  function trackInserted(trackEl, media) {
    var t = trackEl.track;
    if (t._media === media) return;
    t._media = media;
    addToList(textTrackList(media), t);
    // "honor user preferences for automatic text track selection": a default subtitles/captions/descriptions/chapters track is shown.
    queueAlways(function () {
      if (t._mode === "disabled" && trackEl.hasAttribute("default") && !media._defaultTrackChosen) { media._defaultTrackChosen = true; t._mode = t._kind === "metadata" || t._kind === "chapters" ? "hidden" : "showing"; startTrackLoad(trackEl); }
    });
  }
  function trackSrcChanged(el) { if (!el._textTrack) return; el._textTrack._cues.length = 0; el._trackReady = 0; el._trackLoading = false; if (el._textTrack._mode !== "disabled") startTrackLoad(el); }
  function startTrackLoad(el) {
    if (el._trackLoading) return;
    el._trackLoading = true;
    el._trackReady = 1;
    setTimeout(function () {
      var src = el.getAttribute("src"), url = null;
      try { url = src ? new URL(src, el.baseURI).href : null; } catch (e) { url = null; }
      var fail = function () { el._trackReady = 3; fire(el, "error"); };
      if (!url) { fail(); return; }
      var r = null;
      try { r = __jb.hostFetch(url, "GET", {}, null, false, "", null); } catch (e) { r = null; }
      if (!r || !r.result || !(r.result.status >= 200 && r.result.status < 300)) { fail(); return; }
      var text = typeof r.body === "string" ? r.body : __utf8Decode(r.body);
      var cues = __jb.parseWebVTT(text);
      if (cues === null) { fail(); return; }
      cues.forEach(function (c) { c._track = el._textTrack; insertCue(el._textTrack._cues, c); });
      el._trackReady = 2;
      fire(el, "load");
    }, 0);
  }
  // WebVTT parser (cues only; settings applied where simple). Returns null when the signature is wrong.
  __jb.parseWebVTT = function (text) {
    text = String(text).replace(/\u0000/g, "�").replace(/\r\n?/g, "\n");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    if (!/^WEBVTT([ \t\n]|$)/.test(text)) return null;
    var blocks = text.split(/\n{2,}/).slice(1), out = [];
    var ts = function (s) { var m = /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/.exec(s); if (!m) return null; return (m[1] ? parseInt(m[1], 10) * 3600 : 0) + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + parseInt(m[4], 10) / 1000; };
    blocks.forEach(function (b) {
      var lines = b.split("\n").filter(function (l, i, a) { return !(i === a.length - 1 && l === ""); });
      if (!lines.length) return;
      var id = "";
      if (lines[0].indexOf("-->") < 0) { if (/^(NOTE|STYLE|REGION)([ \t]|$)/.test(lines[0])) return; id = lines.shift(); }
      if (!lines.length) return;
      var tm = /^(\S+)[ \t]+-->[ \t]+(\S+)(.*)$/.exec(lines[0]);
      if (!tm) return;
      var s = ts(tm[1]), e = ts(tm[2]);
      if (s === null || e === null) return;
      var cue = new VTTCue(s, e, lines.slice(1).join("\n"));
      cue._id = id;
      tm[3].trim().split(/[ \t]+/).forEach(function (setting) {
        var kv = setting.split(":"); if (kv.length !== 2) return;
        var k = kv[0], v = kv[1];
        if (k === "vertical" && /^(rl|lr)$/.test(v)) cue._vertical = v;
        else if (k === "align" && /^(start|center|end|left|right)$/.test(v)) cue._align = v;
        else if (k === "size" && /^\d+(\.\d+)?%$/.test(v)) cue._size = parseFloat(v);
        else if (k === "position" && /^\d+(\.\d+)?%/.test(v)) cue._position = parseFloat(v);
        else if (k === "line") { var lv = v.split(",")[0]; if (/^-?\d+$/.test(lv)) { cue._line = parseInt(lv, 10); } else if (/^\d+(\.\d+)?%$/.test(lv)) { cue._line = parseFloat(lv); cue._snap = false; } }
      });
      out.push(cue);
    });
    return out;
  };
  // timeupdate drives cuechange / enter / exit for showing or hidden tracks.
  var baseFire = fire;
  fire = function (el, type) {
    baseFire(el, type);
    if (type === "timeupdate" || type === "seeked") {
      var m = st(el); if (!m.textTracks) return;
      m.textTracks._items.forEach(function (t) {
        if (t._mode === "disabled") return;
        var now = m.currentTime, active = t._cues.filter(function (c) { return c._start <= now && now < c._end; });
        var prev = t._active || [];
        var changed = active.length !== prev.length || active.some(function (c, i) { return c !== prev[i]; });
        t._active = active;
        prev.filter(function (c) { return active.indexOf(c) < 0; }).forEach(function (c) { __jb.fireUA(c, "exit"); });
        active.filter(function (c) { return prev.indexOf(c) < 0; }).forEach(function (c) { __jb.fireUA(c, "enter"); });
        if (changed) { __jb.fireUA(t, "cuechange"); if (t._el) __jb.fireUA(t._el, "cuechange"); }
      });
    }
  };

  // ---------------------------------------------------------- Media Source Extensions
  // MediaSource/SourceBuffer on the virtual pipeline: appended bytes are only parsed for their
  // time ranges (fMP4 moov/moof/tfdt/trun, WebM Info/Tracks/Cluster timecodes), nothing is
  // decoded. The buffered ranges drive the element's ready state, and playback advances over
  // them (stalling with `waiting` at the end of the buffered range).
  var mseFor = function (url) { var o = __jb.blobUrls && __jb.blobUrls[url]; return o instanceof MediaSource ? o : null; };
  var MSE_TYPES = { "video/mp4": "mp4", "audio/mp4": "mp4", "video/webm": "webm", "audio/webm": "webm", "audio/mpeg": "mpeg", "audio/aac": "aac" };
  var mseKind = function (type) {
    var s = String(type).trim(), semi = s.indexOf(";"), base = (semi < 0 ? s : s.slice(0, semi)).trim().toLowerCase();
    var k = MSE_TYPES[base];
    if (!k || __jb.canPlayType(s) === "") return null;
    return k;
  };
  // time ranges [[start, end], ...], sorted; neighbours closer than a frame merge
  var addRange = function (list, s, e) {
    if (!(e > s)) return list;
    var out = [];
    list.concat([[s, e]]).sort(function (a, b) { return a[0] - b[0]; }).forEach(function (r) {
      var last = out[out.length - 1];
      if (last && r[0] <= last[1] + 0.05) last[1] = Math.max(last[1], r[1]); else out.push([r[0], r[1]]);
    });
    return out;
  };
  var removeRange = function (list, s, e) {
    var out = [];
    list.forEach(function (r) { if (r[1] <= s || r[0] >= e) out.push([r[0], r[1]]); else { if (r[0] < s) out.push([r[0], s]); if (r[1] > e) out.push([e, r[1]]); } });
    return out;
  };
  var intersectRanges = function (a, b) {
    var out = [];
    a.forEach(function (x) { b.forEach(function (y) { var s = Math.max(x[0], y[0]), e = Math.min(x[1], y[1]); if (e > s) out.push([s, e]); }); });
    return out.sort(function (p, q) { return p[0] - q[0]; });
  };

  // --- fragmented MP4
  var u32 = function (b, o) { return b[o] * 16777216 + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]; };
  var u64 = function (b, o) { return u32(b, o) * 4294967296 + u32(b, o + 4); };
  var fourcc = function (b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]); };
  var boxes = function (b, start, end, fn) {
    var o = start;
    while (o + 8 <= end) {
      var size = u32(b, o), type = fourcc(b, o + 4), hdr = 8;
      if (size === 1) { if (o + 16 > end) break; size = u64(b, o + 8); hdr = 16; }
      else if (size === 0) size = end - o;
      if (size < hdr || !/^[\x20-\x7e]{4}$/.test(type)) break;
      fn(type, o + hdr, Math.min(o + size, end));
      o += size;
    }
  };
  var parseMp4 = function (s, b) {
    var res = { init: false, ranges: [], dur: NaN, w: 0, h: 0, any: false };
    boxes(b, 0, b.length, function (type, bs, be) {
      if (type === "ftyp" || type === "styp" || type === "sidx" || type === "mdat" || type === "emsg" || type === "prft") res.any = true;
      if (type === "moov") {
        res.init = true; res.any = true;
        boxes(b, bs, be, function (t2, s2, e2) {
          if (t2 === "mvhd") {
            var v = b[s2], ts = v === 1 ? u32(b, s2 + 20) : u32(b, s2 + 12), d = v === 1 ? u64(b, s2 + 24) : u32(b, s2 + 16);
            s.movieTimescale = ts;
            if (ts && d && d !== 0xffffffff) res.dur = d / ts;
          } else if (t2 === "mvex") {
            boxes(b, s2, e2, function (t3, s3) {
              if (t3 === "trex") s.trex[u32(b, s3 + 4)] = u32(b, s3 + 12);
              else if (t3 === "mehd" && s.movieTimescale) { var fd = b[s3] === 1 ? u64(b, s3 + 4) : u32(b, s3 + 4); if (fd) res.dur = fd / s.movieTimescale; }
            });
          } else if (t2 === "trak") {
            var id = 0, tsc = 0, w = 0, h = 0, hdl = "";
            boxes(b, s2, e2, function (t3, s3, e3) {
              if (t3 === "tkhd") { id = b[s3] === 1 ? u32(b, s3 + 20) : u32(b, s3 + 12); w = u32(b, e3 - 8) / 65536; h = u32(b, e3 - 4) / 65536; }
              else if (t3 === "mdia") boxes(b, s3, e3, function (t4, s4) {
                if (t4 === "mdhd") tsc = b[s4] === 1 ? u32(b, s4 + 20) : u32(b, s4 + 12);
                else if (t4 === "hdlr") hdl = fourcc(b, s4 + 8);
              });
            });
            if (id) s.tracks[id] = { timescale: tsc || 90000, kind: hdl };
            if (hdl === "vide" && w) { res.w = Math.round(w); res.h = Math.round(h); }
            if (hdl === "vide") s.hasVideo = true;
          }
        });
      } else if (type === "moof") {
        res.any = true;
        boxes(b, bs, be, function (t2, s2, e2) {
          if (t2 !== "traf") return;
          var id = 0, defDur = 0, base = null, total = 0;
          boxes(b, s2, e2, function (t3, s3, e3) {
            if (t3 === "tfhd") {
              var fl = (b[s3 + 1] << 16) | (b[s3 + 2] << 8) | b[s3 + 3], o = s3 + 8;
              id = u32(b, s3 + 4);
              if (fl & 1) o += 8;
              if (fl & 2) o += 4;
              if (fl & 8) defDur = u32(b, o);
            } else if (t3 === "tfdt") base = b[s3] === 1 ? u64(b, s3 + 4) : u32(b, s3 + 4);
            else if (t3 === "trun") {
              var f = (b[s3 + 1] << 16) | (b[s3 + 2] << 8) | b[s3 + 3], n = u32(b, s3 + 4), p = s3 + 8;
              if (f & 1) p += 4;
              if (f & 4) p += 4;
              var per = (f & 0x100 ? 4 : 0) + (f & 0x200 ? 4 : 0) + (f & 0x400 ? 4 : 0) + (f & 0x800 ? 4 : 0);
              var dflt = defDur || s.trex[id] || 0;
              for (var i = 0; i < n && p <= e3; i++) { total += f & 0x100 ? u32(b, p) : dflt; p += per; }
            }
          });
          if (base === null) return;
          var tr = s.tracks[id] || { timescale: 90000 }, a = base / tr.timescale, z = (base + total) / tr.timescale;
          if (!(z > a)) z = a + 0.04;
          res.ranges.push([a, z]);
        });
      }
    });
    return res;
  };

  // --- WebM (EBML)
  var vint = function (b, o, keepMarker) {
    var first = b[o];
    if (first === undefined || first === 0) return null;
    var len = 1, mask = 0x80;
    while (!(first & mask)) { len++; mask >>= 1; }
    if (o + len > b.length) return null;
    var low = first & (mask - 1), v = keepMarker ? first : low, ones = low === mask - 1;
    for (var i = 1; i < len; i++) { v = v * 256 + b[o + i]; if (b[o + i] !== 255) ones = false; }
    return { v: v, len: len, unknown: ones };
  };
  var ebmlUint = function (b, s, e) { var v = 0; for (var i = s; i < e; i++) v = v * 256 + b[i]; return v; };
  var ebmlFloat = function (b, s, e) { var dv = new DataView(b.buffer, b.byteOffset + s, e - s); return e - s === 4 ? dv.getFloat32(0) : e - s === 8 ? dv.getFloat64(0) : NaN; };
  var EBML_MASTER = { 0x18538067: 1, 0x1F43B675: 1, 0x1549A966: 1, 0x1654AE6B: 1, 0xAE: 1, 0xE0: 1, 0xA0: 1 };
  var parseWebm = function (s, b) {
    var res = { init: false, ranges: [], dur: NaN, w: 0, h: 0, any: false };
    var scale = s.tcScale || 1e6, times = [];
    var walk = function (start, end, depth) {
      var o = start;
      while (o < end) {
        var id = vint(b, o, true); if (!id) return;
        var sz = vint(b, o + id.len, false); if (!sz) return;
        var ds = o + id.len + sz.len, de = sz.unknown ? end : Math.min(ds + sz.v, end), ID = id.v;
        if (ID === 0x1A45DFA3 || ID === 0x18538067) res.any = true;
        if (ID === 0x1654AE6B) res.init = true;
        if (EBML_MASTER[ID] && depth < 6) { walk(ds, de, depth + 1); o = de; continue; }
        if (ID === 0x2AD7B1) { scale = ebmlUint(b, ds, de) || 1e6; s.tcScale = scale; }
        else if (ID === 0x4489) res.dur = ebmlFloat(b, ds, de) * scale / 1e9;
        else if (ID === 0xB0) res.w = ebmlUint(b, ds, de);
        else if (ID === 0xBA) res.h = ebmlUint(b, ds, de);
        else if (ID === 0x83 && ebmlUint(b, ds, de) === 1) s.hasVideo = true;
        else if (ID === 0xE7) { s.clusterTc = ebmlUint(b, ds, de); res.any = true; }
        else if (ID === 0xA3 || ID === 0xA1) {
          var tn = vint(b, ds, false);
          if (tn && ds + tn.len + 2 <= de) { var rel = (b[ds + tn.len] << 8) | b[ds + tn.len + 1]; if (rel & 0x8000) rel -= 0x10000; times.push(((s.clusterTc || 0) + rel) * scale / 1e9); }
        }
        if (de <= o) return;
        o = de;
      }
    };
    walk(0, b.length, 0);
    if (times.length) {
      times.sort(function (x, y) { return x - y; });
      var step = times.length > 1 ? (times[times.length - 1] - times[0]) / (times.length - 1) : 0.04;
      res.ranges.push([times[0], times[times.length - 1] + (step > 0 && step < 1 ? step : 0.04)]);
    }
    return res;
  };

  // --- the SourceBuffer append: parse, place by mode/offset/append window, update the element
  var sbAppended = function (sb, bytes) {
    var s = sb._sb, ms = s.ms;
    if (!ms) return;
    var x = ms._mse;
    var res = s.kind === "mp4" ? parseMp4(s, bytes) : s.kind === "webm" ? parseWebm(s, bytes) : { init: !s.gotInit, ranges: [], dur: NaN, w: 0, h: 0, any: true };
    if (res.init && !s.gotInit) {
      s.gotInit = true;
      if (res.w) { x.w = res.w; x.h = res.h; }
      if (s.kind === "mpeg" || s.kind === "aac") s.hasVideo = false;
      if (x.active._items.indexOf(sb) < 0) { x.active._items.push(sb); queueAlways(function () { fire(x.active, "addsourcebuffer"); }); }
      if (isNaN(x.duration)) mseSetDuration(ms, isFinite(res.dur) && res.dur > 0 ? res.dur : Infinity);
    }
    var list = res.ranges, raw = false;
    if (!list.length && (!res.init || s.generate) && bytes.length) {
      // media data the parser could not place (partial boxes, raw MPEG audio): assume a bitrate
      var at = s.groupEnd !== null ? s.groupEnd : s.tso;
      list = [[at, at + Math.max(0.1, bytes.length * 8 / (s.hasVideo ? 2000000 : 128000))]];
      raw = true;
    }
    list.forEach(function (r, i) {
      var a = r[0], z = r[1];
      if (!raw) {
        if (s.mode === "sequence") {
          if (i === 0) s.tso = (s.groupEnd !== null ? s.groupEnd : s.tso) - a;
          a += s.tso; z += s.tso;
        } else { a += s.tso; z += s.tso; }
      }
      a = Math.max(a, s.aws); z = Math.min(z, s.awe);
      if (z > a) { s.buf = addRange(s.buf, a, z); s.groupEnd = z; }
    });
    var high = 0;
    x.sbs._items.forEach(function (o) { var bb = o._sb.buf; if (bb.length) high = Math.max(high, bb[bb.length - 1][1]); });
    if (high > 0 && (isNaN(x.duration) || high > x.duration)) mseSetDuration(ms, high);
  };
  var mseSetDuration = function (ms, d) {
    var x = ms._mse;
    if (x.duration === d || (isNaN(x.duration) && isNaN(d))) return;
    x.duration = d;
    var el = x.el;
    if (!el) return;
    var m = st(el);
    if (m.readyState >= HAVE.METADATA) { m.duration = d; m.seekable = mseSeekable(x, m); queueAlways(function () { fire(el, "durationchange"); }); }
  };
  var mseSeekable = function (x, m) {
    if (isFinite(x.duration)) return x.duration > 0 ? [[0, x.duration]] : [];
    if (x.live) return [x.live.slice()];
    return m.buffered.length ? [[m.buffered[0][0], m.buffered[m.buffered.length - 1][1]]] : [];
  };
  // buffered ranges -> the element's ready state (HTML "media data processing" for MSE)
  function mseRefresh(ms) {
    var x = ms._mse, el = x.el;
    if (!el) return;
    var m = st(el), buf = null;
    x.active._items.forEach(function (sb) { buf = buf === null ? sb._sb.buf.slice() : intersectRanges(buf, sb._sb.buf); });
    m.buffered = buf || [];
    var all = x.sbs._items.length > 0 && x.sbs._items.every(function (sb) { return sb._sb.gotInit; });
    if (!all) return;
    if (m.readyState < HAVE.METADATA) {
      m.duration = x.duration;
      if (isVideo(el)) { m.videoWidth = x.w || 0; m.videoHeight = x.h || 0; }
      m.hasVideo = x.sbs._items.some(function (sb) { return sb._sb.hasVideo; }); m.hasAudio = true;
      if (m.defaultStart) m.currentTime = m.defaultStart;
      fire(el, "durationchange");
      if (isVideo(el) && m.videoWidth) fire(el, "resize");
      m.readyState = HAVE.METADATA;
      fire(el, "loadedmetadata");
      if (x.el !== el) return;
    }
    m.seekable = mseSeekable(x, m);
    var t = m.currentTime, last = m.buffered[m.buffered.length - 1];
    var has = m.buffered.some(function (r) { return r[0] - 0.1 <= t && t < r[1] - 1e-3; }) ||
      (x.readyState === "ended" && last && t >= last[1] - 1e-3);
    if (has) {
      if (m.readyState < HAVE.CURRENT_DATA) { m.readyState = HAVE.CURRENT_DATA; if (!m.loadedData) { m.loadedData = true; fire(el, "loadeddata"); } }
      setReady(el, HAVE.ENOUGH_DATA);
      if (!m.paused && !m.clock) startClock(el); // at the end after endOfStream() the next tick ends playback
    } else if (m.readyState > HAVE.METADATA) {
      var was = m.readyState;
      m.readyState = HAVE.METADATA;
      if (was >= HAVE.FUTURE_DATA && !m.paused) { stopClock(m); fire(el, "waiting"); }
    }
    fire(el, "progress");
  }
  // playback reached the end of the buffered range: stall (or end after endOfStream)
  function mseStall(el, m, before) {
    var x = m.mse._mse, end = null;
    m.buffered.forEach(function (r) { if (r[0] - 0.1 <= before && before <= r[1] + 1e-3) end = r[1]; });
    if (end === null) end = before;
    if (m.currentTime < end) return false;
    if (x.readyState === "ended" && isFinite(m.duration) && end >= m.duration - 0.05) return false;
    m.currentTime = end;
    stopClock(m);
    m.readyState = HAVE.CURRENT_DATA;
    fire(el, "timeupdate");
    fire(el, "waiting");
    return true;
  }
  function mseAttach(el, ms, gen, fail) {
    var x = ms._mse, m = st(el);
    if (x.readyState !== "closed") { fail(); return; }
    m.mse = ms; m.loadedData = false;
    x.el = el; x.readyState = "open"; x.duration = NaN; x.w = 0; x.h = 0;
    m.networkState = NETWORK.LOADING;
    queue(el, function () { if (m.mse === ms) fire(ms, "sourceopen"); });
  }
  function mseDetach(el) {
    var m = st(el), ms = m.mse;
    m.mse = null;
    if (!ms) return;
    var x = ms._mse;
    x.el = null; x.readyState = "closed"; x.duration = NaN; x.live = null;
    var gone = x.sbs._items.splice(0), wasActive = x.active._items.splice(0);
    gone.forEach(function (sb) { sb._sb.ms = null; sb._sb.updating = false; sb._sb.gen++; });
    queueAlways(function () {
      wasActive.forEach(function () { fire(x.active, "removesourcebuffer"); });
      gone.forEach(function () { fire(x.sbs, "removesourcebuffer"); });
      fire(ms, "sourceclose");
    });
  }
  var reopen = function (ms) { var x = ms._mse; if (x.readyState === "ended") { x.readyState = "open"; queueAlways(function () { fire(ms, "sourceopen"); }); } };
  var mseErr = function (name, msg) { return __jb.domError(name, msg); };
  var sbState = function (sb) { var s = sb && sb._sb; if (!s) throw new TypeError("Illegal invocation"); return s; };
  var liveSb = function (sb, what) { var s = sbState(sb); if (!s.ms) throw mseErr("InvalidStateError", "Failed to execute '" + what + "' on 'SourceBuffer': This SourceBuffer has been removed from the parent media source."); return s; };

  class SourceBufferList extends EventTarget {
    constructor() { if (!__jb.mediaConstructing) throw new TypeError("Illegal constructor"); super(); }
    get length() { return this._items.length; }
  }
  __jb.setTag(SourceBufferList, "SourceBufferList");
  __jb.defineEventHandlerProps(SourceBufferList.prototype, ["addsourcebuffer", "removesourcebuffer"]);
  Object.defineProperty(SourceBufferList.prototype, Symbol.iterator, { value: function values() { return (this._items || []).slice()[Symbol.iterator](); }, writable: true, configurable: true });

  class MediaSource extends EventTarget {
    constructor() {
      super();
      Object.defineProperty(this, "_mse", { value: { readyState: "closed", duration: NaN, sbs: trackList(SourceBufferList), active: trackList(SourceBufferList), el: null, live: null, w: 0, h: 0 } });
    }
    static isTypeSupported(type) {
      if (arguments.length < 1) throw new TypeError("Failed to execute 'isTypeSupported' on 'MediaSource': 1 argument required, but only 0 present.");
      return mseKind(type) !== null;
    }
    get sourceBuffers() { return this._mse.sbs; }
    get activeSourceBuffers() { return this._mse.active; }
    get readyState() { return this._mse.readyState; }
    get duration() { var x = this._mse; return x.readyState === "closed" ? NaN : x.duration; }
    set duration(v) {
      v = +v;
      if (isNaN(v) || v < 0) throw new TypeError("Failed to set the 'duration' property on 'MediaSource': The value provided (" + v + ") is outside the range [0, Infinity].");
      var x = this._mse;
      if (x.readyState !== "open") throw mseErr("InvalidStateError", "Failed to set the 'duration' property on 'MediaSource': The MediaSource's readyState is not 'open'.");
      if (x.sbs._items.some(function (sb) { return sb._sb.updating; })) throw mseErr("InvalidStateError", "Failed to set the 'duration' property on 'MediaSource': The 'updating' attribute is true on one or more of this MediaSource's SourceBuffers.");
      x.sbs._items.forEach(function (sb) { sb._sb.buf = removeRange(sb._sb.buf, v, Infinity); });
      mseSetDuration(this, v);
      if (x.el) mseRefresh(this);
    }
    addSourceBuffer(type) {
      if (arguments.length < 1) throw new TypeError("Failed to execute 'addSourceBuffer' on 'MediaSource': 1 argument required, but only 0 present.");
      type = String(type);
      if (type === "") throw new TypeError("Failed to execute 'addSourceBuffer' on 'MediaSource': The type provided is empty.");
      var kind = mseKind(type);
      if (!kind) throw mseErr("NotSupportedError", "Failed to execute 'addSourceBuffer' on 'MediaSource': The type provided ('" + type + "') is unsupported.");
      var x = this._mse;
      if (x.readyState !== "open") throw mseErr("InvalidStateError", "Failed to execute 'addSourceBuffer' on 'MediaSource': The MediaSource's readyState is not 'open'.");
      __jb.mediaConstructing = true;
      try { var sb = new SourceBuffer(); } finally { __jb.mediaConstructing = false; }
      var gen = kind === "mpeg" || kind === "aac";
      Object.defineProperty(sb, "_sb", { value: {
        ms: this, kind: kind, type: type, generate: gen, mode: gen ? "sequence" : "segments", updating: false, gen: 0, buf: [], tso: 0, aws: 0, awe: Infinity,
        groupEnd: null, gotInit: false, tracks: {}, trex: {}, hasVideo: /^video\//i.test(type.trim()), audioTracks: null, videoTracks: null, textTracks: null,
      } });
      x.sbs._items.push(sb);
      var list = x.sbs;
      queueAlways(function () { fire(list, "addsourcebuffer"); });
      return sb;
    }
    removeSourceBuffer(sb) {
      if (!(sb instanceof SourceBuffer)) throw new TypeError("Failed to execute 'removeSourceBuffer' on 'MediaSource': parameter 1 is not of type 'SourceBuffer'.");
      var x = this._mse, i = x.sbs._items.indexOf(sb);
      if (i < 0) throw mseErr("NotFoundError", "Failed to execute 'removeSourceBuffer' on 'MediaSource': The SourceBuffer provided is not contained in this MediaSource.");
      var s = sb._sb;
      if (s.updating) { s.updating = false; s.gen++; queueAlways(function () { fire(sb, "abort"); fire(sb, "updateend"); }); }
      var j = x.active._items.indexOf(sb);
      if (j >= 0) { x.active._items.splice(j, 1); queueAlways(function () { fire(x.active, "removesourcebuffer"); }); }
      x.sbs._items.splice(i, 1);
      queueAlways(function () { fire(x.sbs, "removesourcebuffer"); });
      s.ms = null;
      if (x.el) mseRefresh(this);
    }
    endOfStream(error) {
      var x = this._mse, ms = this;
      if (error !== undefined && error !== "network" && error !== "decode") throw new TypeError("Failed to execute 'endOfStream' on 'MediaSource': The provided value '" + error + "' is not a valid enum value of type EndOfStreamError.");
      if (x.readyState !== "open") throw mseErr("InvalidStateError", "Failed to execute 'endOfStream' on 'MediaSource': The MediaSource's readyState is not 'open'.");
      if (x.sbs._items.some(function (sb) { return sb._sb.updating; })) throw mseErr("InvalidStateError", "Failed to execute 'endOfStream' on 'MediaSource': The 'updating' attribute is true on one or more of this MediaSource's SourceBuffers.");
      x.readyState = "ended";
      queueAlways(function () { fire(ms, "sourceended"); });
      var el = x.el;
      if (error === undefined) {
        var high = 0;
        x.sbs._items.forEach(function (sb) { var bb = sb._sb.buf; if (bb.length) high = Math.max(high, bb[bb.length - 1][1]); });
        mseSetDuration(this, high);
        if (el) { st(el).networkState = NETWORK.IDLE; mseRefresh(this); }
      } else if (el) {
        var m = st(el);
        m.error = mediaError(m.readyState === HAVE.NOTHING ? 4 : error === "network" ? 2 : 3, error === "network" ? "MEDIA_ERR_NETWORK" : "PIPELINE_ERROR_DECODE");
        queueAlways(function () { fire(el, "error"); });
      }
    }
    setLiveSeekableRange(start, end) {
      if (arguments.length < 2) throw new TypeError("Failed to execute 'setLiveSeekableRange' on 'MediaSource': 2 arguments required.");
      start = +start; end = +end;
      if (!isFinite(start) || !isFinite(end)) throw new TypeError("The provided double value is non-finite.");
      var x = this._mse;
      if (x.readyState !== "open") throw mseErr("InvalidStateError", "Failed to execute 'setLiveSeekableRange' on 'MediaSource': The MediaSource's readyState is not 'open'.");
      if (start < 0 || start > end) throw new TypeError("Failed to execute 'setLiveSeekableRange' on 'MediaSource': The start provided (" + start + ") is outside the range (0, " + end + ").");
      x.live = [start, end];
      if (x.el) st(x.el).seekable = mseSeekable(x, st(x.el));
    }
    clearLiveSeekableRange() {
      var x = this._mse;
      if (x.readyState !== "open") throw mseErr("InvalidStateError", "Failed to execute 'clearLiveSeekableRange' on 'MediaSource': The MediaSource's readyState is not 'open'.");
      x.live = null;
      if (x.el) st(x.el).seekable = mseSeekable(x, st(x.el));
    }
  }
  __jb.setTag(MediaSource, "MediaSource");
  __jb.defineEventHandlerProps(MediaSource.prototype, ["sourceopen", "sourceended", "sourceclose"]);

  class SourceBuffer extends EventTarget {
    constructor() { if (!__jb.mediaConstructing) throw new TypeError("Illegal constructor"); super(); }
    get mode() { return sbState(this).mode; }
    set mode(v) {
      v = String(v);
      if (v !== "segments" && v !== "sequence") return; // invalid enum values are ignored on set
      var s = liveSb(this, "mode");
      if (s.updating) throw mseErr("InvalidStateError", "Failed to set the 'mode' property on 'SourceBuffer': This SourceBuffer is still processing an 'appendBuffer' or 'remove' operation.");
      if (s.generate && v === "segments") throw new TypeError("Failed to set the 'mode' property on 'SourceBuffer': The mode value provided (segments) is invalid for a byte stream format that uses generated timestamps.");
      reopen(s.ms);
      if (v === "sequence") s.groupEnd = null;
      s.mode = v;
    }
    get updating() { return sbState(this).updating; }
    get buffered() { var s = liveSb(this, "buffered"); return ranges(s.buf.map(function (r) { return [r[0], r[1]]; })); }
    get timestampOffset() { return sbState(this).tso; }
    set timestampOffset(v) {
      v = +v;
      if (!isFinite(v)) throw new TypeError("Failed to set the 'timestampOffset' property on 'SourceBuffer': The provided double value is non-finite.");
      var s = liveSb(this, "timestampOffset");
      if (s.updating) throw mseErr("InvalidStateError", "Failed to set the 'timestampOffset' property on 'SourceBuffer': This SourceBuffer is still processing an 'appendBuffer' or 'remove' operation.");
      reopen(s.ms);
      s.tso = v;
      if (s.mode === "sequence") s.groupEnd = null;
    }
    get appendWindowStart() { return sbState(this).aws; }
    set appendWindowStart(v) {
      v = +v;
      var s = liveSb(this, "appendWindowStart");
      if (s.updating) throw mseErr("InvalidStateError", "Failed to set the 'appendWindowStart' property on 'SourceBuffer': This SourceBuffer is still processing an 'appendBuffer' or 'remove' operation.");
      if (!isFinite(v) || v < 0 || v >= s.awe) throw new TypeError("Failed to set the 'appendWindowStart' property on 'SourceBuffer': The value provided (" + v + ") is outside the range [0, " + s.awe + ").");
      s.aws = v;
    }
    get appendWindowEnd() { return sbState(this).awe; }
    set appendWindowEnd(v) {
      v = +v;
      var s = liveSb(this, "appendWindowEnd");
      if (s.updating) throw mseErr("InvalidStateError", "Failed to set the 'appendWindowEnd' property on 'SourceBuffer': This SourceBuffer is still processing an 'appendBuffer' or 'remove' operation.");
      if (isNaN(v)) throw new TypeError("Failed to set the 'appendWindowEnd' property on 'SourceBuffer': The value provided is NaN.");
      if (v <= s.aws) throw new TypeError("Failed to set the 'appendWindowEnd' property on 'SourceBuffer': The value provided (" + v + ") is less than or equal to the minimum value (" + s.aws + ").");
      s.awe = v;
    }
    get audioTracks() { var s = sbState(this); return s.audioTracks || (s.audioTracks = trackList(AudioTrackList)); }
    get videoTracks() { var s = sbState(this); return s.videoTracks || (s.videoTracks = trackList(VideoTrackList)); }
    get textTracks() { var s = sbState(this); return s.textTracks || (s.textTracks = trackList(TextTrackList)); }
    appendBuffer(data) {
      if (arguments.length < 1) throw new TypeError("Failed to execute 'appendBuffer' on 'SourceBuffer': 1 argument required, but only 0 present.");
      var bytes;
      if (data instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && data instanceof SharedArrayBuffer)) bytes = new Uint8Array(data.slice(0));
      else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
      else throw new TypeError("Failed to execute 'appendBuffer' on 'SourceBuffer': The provided value is not of type '(ArrayBuffer or ArrayBufferView)'.");
      var s = liveSb(this, "appendBuffer");
      if (s.updating) throw mseErr("InvalidStateError", "Failed to execute 'appendBuffer' on 'SourceBuffer': This SourceBuffer is still processing an 'appendBuffer' or 'remove' operation.");
      var el = s.ms._mse.el;
      if (el && st(el).error) throw mseErr("InvalidStateError", "Failed to execute 'appendBuffer' on 'SourceBuffer': The HTMLMediaElement.error attribute is not null.");
      reopen(s.ms);
      s.updating = true;
      var sb = this, gen = ++s.gen;
      queueAlways(function () { if (s.gen === gen) fire(sb, "updatestart"); });
      queueAlways(function () {
        if (s.gen !== gen || !s.updating) return;
        var ms = s.ms;
        try { sbAppended(sb, bytes); } catch (e) { /* unparsable bytes still complete the append */ }
        s.updating = false;
        fire(sb, "update");
        fire(sb, "updateend");
        if (ms && ms._mse.el) mseRefresh(ms);
      });
    }
    abort() {
      var s = liveSb(this, "abort");
      if (s.ms._mse.readyState !== "open") throw mseErr("InvalidStateError", "Failed to execute 'abort' on 'SourceBuffer': The parent media source's readyState is not 'open'.");
      if (s.updating) { s.updating = false; s.gen++; var sb = this; queueAlways(function () { fire(sb, "abort"); fire(sb, "updateend"); }); }
      s.aws = 0; s.awe = Infinity;
    }
    remove(start, end) {
      if (arguments.length < 2) throw new TypeError("Failed to execute 'remove' on 'SourceBuffer': 2 arguments required.");
      start = +start; end = +end;
      var s = liveSb(this, "remove");
      if (s.updating) throw mseErr("InvalidStateError", "Failed to execute 'remove' on 'SourceBuffer': This SourceBuffer is still processing an 'appendBuffer' or 'remove' operation.");
      var d = s.ms._mse.duration;
      if (isNaN(d) || !(start >= 0) || start > d) throw new TypeError("Failed to execute 'remove' on 'SourceBuffer': The start provided (" + start + ") is outside the range (0, " + d + ").");
      if (!(end > start)) throw new TypeError("Failed to execute 'remove' on 'SourceBuffer': The end value provided (" + end + ") must be greater than the start value provided (" + start + ").");
      reopen(s.ms);
      s.updating = true;
      var sb = this, gen = ++s.gen;
      queueAlways(function () { if (s.gen === gen) fire(sb, "updatestart"); });
      queueAlways(function () {
        if (s.gen !== gen || !s.updating) return;
        s.buf = removeRange(s.buf, start, end);
        s.updating = false;
        fire(sb, "update");
        fire(sb, "updateend");
        if (s.ms && s.ms._mse.el) mseRefresh(s.ms);
      });
    }
    changeType(type) {
      if (arguments.length < 1) throw new TypeError("Failed to execute 'changeType' on 'SourceBuffer': 1 argument required, but only 0 present.");
      type = String(type);
      if (type === "") throw new TypeError("Failed to execute 'changeType' on 'SourceBuffer': The type provided is empty.");
      var s = liveSb(this, "changeType");
      if (s.updating) throw mseErr("InvalidStateError", "Failed to execute 'changeType' on 'SourceBuffer': This SourceBuffer is still processing an 'appendBuffer' or 'remove' operation.");
      var kind = mseKind(type);
      if (!kind) throw mseErr("NotSupportedError", "Failed to execute 'changeType' on 'SourceBuffer': The type provided ('" + type + "') is not supported.");
      reopen(s.ms);
      s.kind = kind; s.type = type; s.generate = kind === "mpeg" || kind === "aac";
      if (s.generate) s.mode = "sequence";
      s.tracks = {}; s.trex = {};
    }
  }
  __jb.setTag(SourceBuffer, "SourceBuffer");
  __jb.defineEventHandlerProps(SourceBuffer.prototype, ["updatestart", "update", "updateend", "error", "abort"]);

  Object.assign(globalThis, { MediaSource: MediaSource, SourceBuffer: SourceBuffer, SourceBufferList: SourceBufferList });

  Object.assign(globalThis, { MediaError: MediaError, TimeRanges: TimeRanges, TextTrack: TextTrack, TextTrackList: TextTrackList, TextTrackCue: TextTrackCue, TextTrackCueList: TextTrackCueList, VTTCue: VTTCue, TrackEvent: TrackEvent, AudioTrackList: AudioTrackList, VideoTrackList: VideoTrackList });
})();
