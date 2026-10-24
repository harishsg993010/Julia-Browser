// Part 19: DeviceOrientation Event (DeviceOrientationEvent, DeviceMotionEvent and their
// acceleration / rotation-rate objects). Readings come from WebDriver virtual sensors
// (testdriver create/update_virtual_sensor); each update fires the event on window with
// coarsened values, null values for disconnected sensors.
(function () {
  if (globalThis.__jb_workerRealm) return;
  var dom = function (n, m) { return __jb.domError(n, m); };
  var perm = function (n) { try { return __jb.permissionState(n); } catch (e) { return "prompt"; } };
  var activation = function () { return typeof __jb.hasTransientActivation === "function" && __jb.hasTransientActivation(); };
  var num = function (v) { return v === undefined || v === null ? null : Number(v); };
  var coarse = function (v, res) { return v === null ? null : Math.round(v / res) * res; };

  class DeviceMotionEventAcceleration { constructor() { throw new TypeError("Illegal constructor"); } get x() { return this._v.x; } get y() { return this._v.y; } get z() { return this._v.z; } }
  class DeviceMotionEventRotationRate { constructor() { throw new TypeError("Illegal constructor"); } get alpha() { return this._v.alpha; } get beta() { return this._v.beta; } get gamma() { return this._v.gamma; } }
  var accel = function (d) { if (d === undefined || d === null) return null; var o = Object.create(DeviceMotionEventAcceleration.prototype); Object.defineProperty(o, "_v", { value: { x: num(d.x), y: num(d.y), z: num(d.z) } }); return o; };
  var rate = function (d) { if (d === undefined || d === null) return null; var o = Object.create(DeviceMotionEventRotationRate.prototype); Object.defineProperty(o, "_v", { value: { alpha: num(d.alpha), beta: num(d.beta), gamma: num(d.gamma) } }); return o; };
  var requestPermission = function (names) {
    return new Promise(function (resolve) {
      var states = names.map(perm);
      if (states.some(function (s) { return s === "denied"; })) { resolve("denied"); return; }
      if (states.every(function (s) { return s === "granted"; })) { resolve("granted"); return; }
      if (!activation()) throw dom("NotAllowedError", "requestPermission() requires user activation");
      resolve("denied");
    });
  };
  class DeviceOrientationEvent extends Event {
    constructor(type, init) {
      if (arguments.length < 1) throw new TypeError("DeviceOrientationEvent constructor: 1 argument required");
      super(type, init);
      init = init || {};
      Object.defineProperty(this, "_o", { value: { alpha: num(init.alpha), beta: num(init.beta), gamma: num(init.gamma), absolute: !!init.absolute } });
    }
    get alpha() { return this._o.alpha; } get beta() { return this._o.beta; } get gamma() { return this._o.gamma; } get absolute() { return this._o.absolute; }
    static requestPermission(absolute) { return requestPermission(absolute ? ["accelerometer", "gyroscope", "magnetometer"] : ["accelerometer", "gyroscope"]); }
  }
  class DeviceMotionEvent extends Event {
    constructor(type, init) {
      if (arguments.length < 1) throw new TypeError("DeviceMotionEvent constructor: 1 argument required");
      super(type, init);
      init = init || {};
      Object.defineProperty(this, "_m", { value: { acceleration: accel(init.acceleration), accelerationIncludingGravity: accel(init.accelerationIncludingGravity), rotationRate: rate(init.rotationRate), interval: init.interval === undefined ? 0 : Number(init.interval) } });
    }
    get acceleration() { return this._m.acceleration; } get accelerationIncludingGravity() { return this._m.accelerationIncludingGravity; }
    get rotationRate() { return this._m.rotationRate; } get interval() { return this._m.interval; }
    static requestPermission() { return requestPermission(["accelerometer", "gyroscope"]); }
  }

  // ---- firing from virtual sensors ----
  var topJb = function () { try { return __jb.topJb ? __jb.topJb() : __jb; } catch (e) { return __jb; } };
  var sensor = function (t) { var s = topJb().virtualSensors; return s ? s[t] : undefined; };
  var hidden = function () { try { return document.visibilityState === "hidden"; } catch (e) { return false; } };
  var fire = function (ev) { try { __jb.setTrusted(ev, true); ev._trustedDispatch = true; } catch (e) {} globalThis.dispatchEvent(ev); };
  var motionPending = false;
  var reading = function (t) { var s = sensor(t); return s && s.connected && s.reading ? s.reading : null; };
  var fireMotion = function () {
    motionPending = false;
    if (hidden()) return;
    if (perm("accelerometer") === "denied" || perm("gyroscope") === "denied") return;
    var a = reading("linear-acceleration"), g = reading("accelerometer"), r = reading("gyroscope"), D = 180 / Math.PI;
    var res = 0.1;
    fire(new DeviceMotionEvent("devicemotion", {
      acceleration: a ? { x: coarse(a.x, res), y: coarse(a.y, res), z: coarse(a.z, res) } : null,
      accelerationIncludingGravity: g ? { x: coarse(g.x, res), y: coarse(g.y, res), z: coarse(g.z, res) } : null,
      rotationRate: r ? { alpha: coarse(r.x * D, res), beta: coarse(r.y * D, res), gamma: coarse(r.z * D, res) } : null,
      interval: 16,
    }));
  };
  var fireOrientation = function (absolute) {
    if (hidden()) return;
    if (perm("accelerometer") === "denied" || perm("gyroscope") === "denied" || (absolute && perm("magnetometer") === "denied")) return;
    var r = reading(absolute ? "absolute-orientation" : "relative-orientation");
    var res = 0.1;
    fire(new DeviceOrientationEvent(absolute ? "deviceorientationabsolute" : "deviceorientation", {
      alpha: r ? coarse(r.alpha, res) : null, beta: r ? coarse(r.beta, res) : null, gamma: r ? coarse(r.gamma, res) : null, absolute: absolute,
    }));
  };
  __jb.virtualSensorReading = function (type) {
    if (type === "accelerometer" || type === "linear-acceleration" || type === "gyroscope") {
      if (!motionPending) { motionPending = true; setTimeout(fireMotion, 0); }
    } else if (type === "relative-orientation") setTimeout(function () { fireOrientation(false); }, 0);
    else if (type === "absolute-orientation") setTimeout(function () { fireOrientation(true); }, 0);
  };
  ["deviceorientation", "deviceorientationabsolute", "devicemotion"].forEach(function (n) {
    if (__jb.defineEventHandlerProps && !Object.getOwnPropertyDescriptor(globalThis, "on" + n)) { try { __jb.defineEventHandlerProps(globalThis, [n]); } catch (e) {} }
  });
  [DeviceOrientationEvent, DeviceMotionEvent, DeviceMotionEventAcceleration, DeviceMotionEventRotationRate].forEach(function (C) {
    Object.defineProperty(C.prototype, Symbol.toStringTag, { value: C.name, configurable: true });
    globalThis[C.name] = C;
  });
})();
