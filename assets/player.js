(function () {
  "use strict";

  const MAX_RIPPLES = 10;
  const MAX_TRAILS = 18;
  const SAMPLE_W = 64;
  const SAMPLE_H = 36;

  function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
  }

  function rgbToHsl(r, g, b) {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    let h = 0;
    let s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const diff = max - min;
      s = l > 0.5 ? diff / (2 - max - min) : diff / (max + min);
      if (max === rn) h = (gn - bn) / diff + (gn < bn ? 6 : 0);
      else if (max === gn) h = (bn - rn) / diff + 2;
      else h = (rn - gn) / diff + 4;
      h *= 60;
    }
    return { h, s, l };
  }

  function hslToRgbaString(h, s, l, a) {
    return `hsla(${Math.round(h)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%, ${a})`;
  }

  function fallbackSample(nx, ny, zoomPos) {
    const palette = [
      [112, 74, 245],
      [240, 146, 74],
      [64, 214, 186],
      [230, 86, 178],
      [148, 224, 108]
    ];
    const idx = Math.abs(Math.floor(zoomPos * 2 + nx * 3 + ny * 2)) % palette.length;
    const [r, g, b] = palette[idx];
    const hsl = rgbToHsl(r, g, b);
    return { r, g, b, h: hsl.h, s: hsl.s, l: hsl.l, edge: 0.45 };
  }

  function createZoomPlayer(options = {}) {
    const config = options || {};
    const canvas = config.canvas;
    const overlayCanvas = config.overlayCanvas;
    const audio = config.audio || null;
    if (!canvas) {
      throw new Error("A canvas is required.");
    }

    const isFileProtocol = window.location.protocol === "file:";
    const gl = isFileProtocol ? null : canvas.getContext("webgl2");
    const renderer = gl ? "webgl" : "canvas";
    let ctx2d = null;
    const overlayCtx = overlayCanvas ? overlayCanvas.getContext("2d") : null;
    canvas.dataset.renderer = renderer;

    const scratchCanvas = document.createElement("canvas");
    scratchCanvas.width = SAMPLE_W;
    scratchCanvas.height = SAMPLE_H;
    const scratchCtx = scratchCanvas.getContext("2d", { willReadFrequently: true });
    let pixelSamplingAllowed = !isFileProtocol;

    let tileProgram;
    let tileLocations;
    let fxProgram;
    let fxLocations;
    let compositeTexture;
    let compositeFramebuffer;
    let quadBuffer;

    const imageArray = config.imgarray ?? [];
    const useMipmaps = config.useMipmaps ?? true;
    const version = config.version ?? 1;
    let speed = config.speed ?? 9;
    const maxSpeed = config.maxspeed ?? 45;
    const keyboardMovementEnabled = config.keyboardmovementenabled ?? true;
    const visibleSteps = config.visiblesteps ?? 3;
    const randomStart = config.randomstart ?? false;

    let imageWidth;
    let imageHeight;
    let centerX;
    let centerY;
    let baseWidth;
    let baseHeight;
    let canvasWidth;
    let canvasHeight;
    let viewportWidth = window.innerWidth;
    let viewportHeight = window.innerHeight;
    let position = randomStart && imageArray.length > 0 ? Math.random() * imageArray.length : 0;
    let lastTimestamp = null;
    let playing = true;
    const directions = { up: false, down: false };
    let touchVelocity = 0;
    let touching = false;
    let wheelNudge = 0;
    let isPortrait = false;
    let elapsedTime = 0;
    let texelWidth = 1;
    let texelHeight = 1;
    let loadedCount = 0;
    let startLoaded = false;
    let isLoading = true;
    const textureQueue = [];
    let uploadScheduled = false;
    const uploadsPerIdleAfterStart = 1;
    const uploadsPerIdleBeforeStart = 1;
    const preloadBehind = 1;
    const preloadAheadMin = 2;
    const preloadAheadMax = 6;
    let devicePixelRatioValue = 1;
    let tiles = [];
    const bodyElement = document.body;

    // Interactive living-world state
    const pointer = {
      x: 0.5,
      y: 0.5,
      targetX: 0.5,
      targetY: 0.5,
      vx: 0,
      vy: 0,
      active: 0,
      isInside: false,
      isDown: false,
      hold: 0,
      holdDuration: 0,
      idleTime: 0,
      sample: { r: 140, g: 190, b: 255, h: 215, s: 0.85, l: 0.72, edge: 0.4 }
    };

    const secondaryHand = {
      x: 0.5,
      y: 0.5,
      targetX: 0.5,
      targetY: 0.5,
      active: 0,
      isInside: false,
      isDown: false,
      hold: 0,
      sample: { r: 140, g: 190, b: 255, h: 215, s: 0.85, l: 0.72, edge: 0.4 }
    };

    let lastDirectPointerAt = -10000;
    let directPointerDown = false;
    let handDrivingPointer = false;
    let handRoutedToSecondary = false;

    let panX = 0;
    let panY = 0;
    let targetPanX = 0;
    let targetPanY = 0;
    let warpEnergy = 0;
    let lastActiveDrawList = [];

    const ripples = [];
    const trails = [];
    const spores = [];
    const blooms = [];
    const ribbonPoints = [];
    const secondaryRibbonPoints = [];
    const tendrils = [];
    const rippleUniformData = new Float32Array(MAX_RIPPLES * 4);
    const trailUniformData = new Float32Array(MAX_TRAILS * 4);

    let resizeCompositeFramebuffer = function () {};
    let orthoMatrix = function () {
      return [];
    };

    if (renderer === "canvas") {
      ctx2d = canvas.getContext("2d");
    } else if (renderer === "webgl") {
      const compileShader = function (type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
          console.error(gl.getShaderInfoLog(shader));
        }
        return shader;
      };

      const linkProgram = function (vertexShader, fragmentShader) {
        const program = gl.createProgram();
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
          console.error(gl.getProgramInfoLog(program));
        }
        return program;
      };

      resizeCompositeFramebuffer = function () {
        if (!compositeTexture || !compositeFramebuffer) return;
        texelWidth = 1 / Math.max(canvas.width || 1, 1);
        texelHeight = 1 / Math.max(canvas.height || 1, 1);
        gl.bindTexture(gl.TEXTURE_2D, compositeTexture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          Math.max(canvas.width, 1),
          Math.max(canvas.height, 1),
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          null
        );
        gl.bindFramebuffer(gl.FRAMEBUFFER, compositeFramebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, compositeTexture, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
          console.error("Composite framebuffer is incomplete");
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindTexture(gl.TEXTURE_2D, null);
      };

      const initCompositeTargets = function () {
        quadBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
        compositeTexture = gl.createTexture();
        compositeFramebuffer = gl.createFramebuffer();
        resizeCompositeFramebuffer();
      };

      const tileVertexSource = `
        precision mediump float;
        attribute vec2 aVertexPosition;
        attribute vec2 aTextureCoord;
        uniform mat3 uTransformationMatrix;
        uniform mat4 uProjectionMatrix;
        varying highp vec2 vTextureCoord;

        void main() {
          vec4 position = uProjectionMatrix * vec4(uTransformationMatrix * vec3(aVertexPosition, 1.0), 1.0);
          gl_Position = position;
          vTextureCoord = aTextureCoord;
        }
      `;

      const tileFragmentSource = `
        precision mediump float;
        varying highp vec2 vTextureCoord;
        uniform sampler2D uSampler;

        void main(void) {
          gl_FragColor = texture2D(uSampler, vTextureCoord);
        }
      `;

      const fxVertexSource = `
        precision mediump float;
        attribute vec2 aVertexPosition;
        attribute vec2 aTextureCoord;
        varying highp vec2 vTextureCoord;

        void main() {
          vec2 clipPosition = aVertexPosition * 2.0 - 1.0;
          gl_Position = vec4(clipPosition, 0.0, 1.0);
          vTextureCoord = aTextureCoord;
        }
      `;

      const fxFragmentSource = `
        precision mediump float;
        precision mediump int;
        varying highp vec2 vTextureCoord;
        uniform sampler2D uSampler;
        uniform vec2 uResolution;
        uniform vec2 uTexelSize;
        uniform float uTime;
        uniform vec2 uPointer;
        uniform vec2 uPointerVel;
        uniform float uPointerActive;
        uniform float uHoldAmount;
        uniform float uWarpEnergy;
        uniform vec4 uRipples[${MAX_RIPPLES}];
        uniform vec4 uTrails[${MAX_TRAILS}];

        float luma(vec3 color) {
          return dot(color, vec3(0.299, 0.587, 0.114));
        }

        vec2 clampUv(vec2 uv) {
          vec2 padding = max(uTexelSize * 2.0, vec2(0.0005));
          return clamp(uv, padding, vec2(1.0) - padding);
        }

        vec3 sampleScene(vec2 uv) {
          return texture2D(uSampler, clampUv(uv)).rgb;
        }

        vec3 hueShift(vec3 color, float angle) {
          const mat3 toYiq = mat3(
            0.299, 0.587, 0.114,
            0.596, -0.275, -0.321,
            0.212, -0.523, 0.311
          );
          const mat3 toRgb = mat3(
            1.0, 0.956, 0.621,
            1.0, -0.272, -0.647,
            1.0, -1.107, 1.704
          );
          vec3 yiq = toYiq * color;
          float baseHue = atan(yiq.z, yiq.y) + angle;
          float chroma = sqrt(yiq.y * yiq.y + yiq.z * yiq.z);
          return clamp(toRgb * vec3(yiq.x, chroma * cos(baseHue), chroma * sin(baseHue)), 0.0, 1.0);
        }

        float detectEdge(vec2 uv) {
          vec2 d = uTexelSize * 1.5;
          float tl = luma(sampleScene(uv + vec2(-d.x, -d.y)));
          float tc = luma(sampleScene(uv + vec2(0.0, -d.y)));
          float tr = luma(sampleScene(uv + vec2(d.x, -d.y)));
          float ml = luma(sampleScene(uv + vec2(-d.x, 0.0)));
          float mr = luma(sampleScene(uv + vec2(d.x, 0.0)));
          float bl = luma(sampleScene(uv + vec2(-d.x, d.y)));
          float bc = luma(sampleScene(uv + vec2(0.0, d.y)));
          float br = luma(sampleScene(uv + vec2(d.x, d.y)));
          float gx = -tl - 2.0 * ml - bl + tr + 2.0 * mr + br;
          float gy = -tl - 2.0 * tc - tr + bl + 2.0 * bc + br;
          return clamp(sqrt(gx * gx + gy * gy) * 1.75, 0.0, 1.0);
        }

        vec3 softGlowAdd(vec3 baseColor, vec3 glowColor, float amount) {
          vec3 added = glowColor * amount;
          return baseColor + added * (vec3(1.0) - baseColor * 0.72);
        }

        void main(void) {
          vec2 resolution = max(uResolution, vec2(1.0));
          float aspect = resolution.x / resolution.y;
          vec2 screenUv = vTextureCoord;

          vec2 centerDelta = screenUv - vec2(0.5);
          vec2 centerAspect = vec2(centerDelta.x * aspect, centerDelta.y);
          float centerDist = length(centerAspect);

          vec2 pDelta = screenUv - uPointer;
          vec2 pAspect = vec2(pDelta.x * aspect, pDelta.y);
          float pDist = length(pAspect);
          vec2 pDir = pDist > 0.0001 ? pAspect / pDist : vec2(0.0, 1.0);
          vec2 pTan = vec2(-pDir.y, pDir.x);
          float pAngle = atan(pAspect.y, pAspect.x);

          float nearField = exp(-pDist * pDist * 26.0) * uPointerActive;
          float wideField = exp(-pDist * pDist * 8.5) * uPointerActive;
          float velMag = clamp(length(uPointerVel) * 32.0, 0.0, 2.0);

          vec2 warp = vec2(0.0);
          float energyGlow = 0.0;
          float chromaShift = 0.0;
          float holdCaustic = 0.0;

          // Living silk-water field & bioluminescent awakening around pointer
          float silkWave = sin(pDist * 28.0 - uTime * 4.2 + sin(pAngle * 3.0 + uTime * 0.9));
          float curlFlow = cos(pDist * 18.0 + uTime * 2.6 - pAngle * 2.0);
          warp += vec2(pDir.x / aspect, pDir.y) * (0.0095 * silkWave * wideField);
          warp += vec2(pTan.x / aspect, pTan.y) * (0.007 * curlFlow * wideField * (0.5 + velMag * 0.7));
          warp -= uPointerVel * wideField * 0.85;
          energyGlow += wideField * (0.62 + 0.45 * velMag);
          chromaShift += nearField * (0.0026 + velMag * 0.0042);

          // Press-and-hold living spacetime vortex & kaleidoscopic time-lens
          if (uHoldAmount > 0.001) {
            float holdCore = exp(-pDist * pDist * 13.5) * uHoldAmount;
            float holdHalo = exp(-pDist * pDist * 5.2) * uHoldAmount;
            float floralSym = 0.5 + 0.5 * cos(pAngle * 6.0 - uTime * 2.4 + pDist * 16.0);
            float twist = (0.058 + 0.024 * floralSym) * holdCore;
            warp += vec2(pTan.x / aspect, pTan.y) * twist;
            warp -= vec2(pDir.x / aspect, pDir.y) * (0.036 * holdCore * (0.7 + 0.3 * sin(uTime * 3.2 - pDist * 14.0)));
            energyGlow += holdHalo * 0.82;
            chromaShift += holdCore * 0.0095;
            float horizon = exp(-pow((pDist - (0.145 + 0.045 * uHoldAmount)) / 0.032, 2.0)) * uHoldAmount;
            holdCaustic = horizon * (0.55 + 0.45 * floralSym);
          }

          // Zoom-space-locked fluid silk trails
          for (int i = 0; i < ${MAX_TRAILS}; i++) {
            vec4 tr = uTrails[i];
            if (tr.z > 0.01) {
              vec2 td = screenUv - tr.xy;
              vec2 ta = vec2(td.x * aspect, td.y);
              float dist = length(ta);
              float falloff = exp(-dist * dist * 48.0) * tr.z;
              vec2 tDir = dist > 0.0001 ? ta / dist : vec2(0.0, 1.0);
              vec2 tTan = vec2(-tDir.y, tDir.x);
              float amp = 0.0145 * tr.w;
              warp += vec2(tTan.x / aspect, tTan.y) * (falloff * amp * sin(uTime * 4.4 + dist * 28.0));
              warp += vec2(tDir.x / aspect, tDir.y) * (falloff * amp * 0.52);
              energyGlow += falloff * 0.46;
              chromaShift += falloff * 0.0032;
            }
          }

          // Zoom-space-locked dual-harmonic shockwaves (positive = expand, negative = implode)
          float rippleGlow = 0.0;
          for (int i = 0; i < ${MAX_RIPPLES}; i++) {
            vec4 rp = uRipples[i];
            float strength = abs(rp.w);
            if (strength > 0.01) {
              float dirSign = rp.w >= 0.0 ? 1.0 : -1.0;
              vec2 rd = screenUv - rp.xy;
              vec2 ra = vec2(rd.x * aspect, rd.y);
              float dist = length(ra);
              float waveRadius = dirSign > 0.0 ? (rp.z * 0.58) : max(0.0, 0.52 - rp.z * 0.54);
              float bandWidth = 0.048 + rp.z * 0.052;
              float ringDelta = dist - waveRadius;
              float envelope = exp(-(ringDelta * ringDelta) / (bandWidth * bandWidth)) * strength;
              float echoDelta = dist - waveRadius * 0.72;
              float echoEnv = exp(-(echoDelta * echoDelta) / (bandWidth * bandWidth * 0.65)) * strength * 0.48;
              float totalEnv = envelope + echoEnv;
              float wave = sin(ringDelta * 72.0 - uTime * 3.6 * dirSign) * envelope + sin(echoDelta * 54.0) * echoEnv * 0.6;
              vec2 rDir = dist > 0.0001 ? ra / dist : vec2(0.0, 1.0);
              warp += vec2(rDir.x / aspect, rDir.y) * (wave * 0.026 * dirSign);
              rippleGlow += totalEnv;
              chromaShift += totalEnv * 0.0075;
            }
          }

          // High-speed scroll warp prism pull
          if (uWarpEnergy > 0.01) {
            vec2 cDir = centerDist > 0.0001 ? centerAspect / centerDist : vec2(0.0, 1.0);
            warp -= vec2(cDir.x / aspect, cDir.y) * (centerDist * 0.045 * uWarpEnergy);
            chromaShift += centerDist * 0.012 * uWarpEnergy;
          }

          vec2 uv = clampUv(screenUv + warp);

          vec2 chromaDir = length(warp) > 0.00005 ? normalize(warp) : vec2(pDir.x / aspect, pDir.y);
          vec3 sceneColor;
          if (chromaShift > 0.00035) {
            float cShift = min(chromaShift, 0.018);
            sceneColor = vec3(
              sampleScene(uv + chromaDir * cShift).r,
              sampleScene(uv).g,
              sampleScene(uv - chromaDir * cShift).b
            );
          } else {
            sceneColor = sampleScene(uv);
          }

          // Subtle radial warp-speed echo when scrolling fast
          if (uWarpEnergy > 0.04) {
            vec2 radialPull = (vec2(0.5) - uv) * 0.022 * uWarpEnergy;
            vec3 echoA = sampleScene(uv + radialPull);
            vec3 echoB = sampleScene(uv + radialPull * 2.0);
            sceneColor = mix(sceneColor, (sceneColor + echoA + echoB) * 0.3333, min(0.55, uWarpEnergy * 0.6));
          }

          // Real-time painted edge bioluminescence with jewel-like soft highlight compression
          float edge = detectEdge(uv);
          float ambientBreath = (0.14 + 0.08 * sin(uTime * 1.4 - centerDist * 10.0)) * exp(-centerDist * centerDist * 3.0);
          float activeMask = clamp(energyGlow + rippleGlow * 1.15 + ambientBreath, 0.0, 1.75);

          vec3 vividBase = mix(vec3(luma(sceneColor)), sceneColor, 1.45);
          vec3 awakenedTint = hueShift(max(vividBase, vec3(0.16, 0.26, 0.38)), 0.75 + uTime * 0.48 + pDist * 2.8);
          vec3 prismTint = hueShift(awakenedTint, 1.65 + centerDist * 2.0);

          vec3 color = sceneColor;
          float lum = luma(color);
          color = mix(color, mix(vec3(lum), color, 1.28), clamp(activeMask * 0.55, 0.0, 0.72));
          color = softGlowAdd(color, awakenedTint, edge * activeMask * 0.85);
          color = softGlowAdd(color, mix(awakenedTint, prismTint, 0.5), rippleGlow * (0.24 + 0.5 * edge));

          if (uHoldAmount > 0.01) {
            float vortexZone = exp(-pDist * pDist * 14.0) * uHoldAmount;
            color = mix(color, hueShift(color, uTime * 0.65 + pDist * 5.0), vortexZone * 0.38);
            color = softGlowAdd(color, prismTint, holdCaustic * 0.95);
          }

          gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
        }
      `;

      orthoMatrix = function (left, right, bottom, top, near, far) {
        return [
          2 / (right - left), 0, 0, 0,
          0, 2 / (top - bottom), 0, 0,
          0, 0, 2 / (near - far), 0,
          (left + right) / (left - right), (bottom + top) / (bottom - top), (near + far) / (near - far), 1
        ];
      };

      const tileVs = compileShader(gl.VERTEX_SHADER, tileVertexSource);
      const tileFs = compileShader(gl.FRAGMENT_SHADER, tileFragmentSource);
      const fxVs = compileShader(gl.VERTEX_SHADER, fxVertexSource);
      const fxFs = compileShader(gl.FRAGMENT_SHADER, fxFragmentSource);

      tileProgram = linkProgram(tileVs, tileFs);
      fxProgram = linkProgram(fxVs, fxFs);

      tileLocations = {
        aVertexPosition: gl.getAttribLocation(tileProgram, "aVertexPosition"),
        aTextureCoord: gl.getAttribLocation(tileProgram, "aTextureCoord"),
        uTransformationMatrix: gl.getUniformLocation(tileProgram, "uTransformationMatrix"),
        uProjectionMatrix: gl.getUniformLocation(tileProgram, "uProjectionMatrix"),
        uSampler: gl.getUniformLocation(tileProgram, "uSampler")
      };

      fxLocations = {
        aVertexPosition: gl.getAttribLocation(fxProgram, "aVertexPosition"),
        aTextureCoord: gl.getAttribLocation(fxProgram, "aTextureCoord"),
        uSampler: gl.getUniformLocation(fxProgram, "uSampler"),
        uResolution: gl.getUniformLocation(fxProgram, "uResolution"),
        uTexelSize: gl.getUniformLocation(fxProgram, "uTexelSize"),
        uTime: gl.getUniformLocation(fxProgram, "uTime"),
        uPointer: gl.getUniformLocation(fxProgram, "uPointer"),
        uPointerVel: gl.getUniformLocation(fxProgram, "uPointerVel"),
        uPointerActive: gl.getUniformLocation(fxProgram, "uPointerActive"),
        uHoldAmount: gl.getUniformLocation(fxProgram, "uHoldAmount"),
        uWarpEnergy: gl.getUniformLocation(fxProgram, "uWarpEnergy"),
        uRipples: gl.getUniformLocation(fxProgram, "uRipples[0]"),
        uTrails: gl.getUniformLocation(fxProgram, "uTrails[0]")
      };

      initCompositeTargets();
    }

    function wrapTileIndex(index) {
      return tiles.length ? ((index % tiles.length) + tiles.length) % tiles.length : 0;
    }

    function checkVisibleReady(delta) {
      let ready = true;
      for (let step = 0; step < visibleSteps; step++) {
        const index = delta >= 0 ? wrapTileIndex(Math.floor(position) + step) : wrapTileIndex(Math.floor(position) - step);
        const tile = tiles[index];
        if (!tile || !tile.imgLoaded || (renderer === "webgl" && !tile.textureLoaded)) {
          ready = false;
        }
      }
      if (!ready && !isLoading) {
        isLoading = true;
        bodyElement.classList.add("loading");
      } else if (ready && isLoading) {
        isLoading = false;
        bodyElement.classList.remove("loading");
      }
      return ready;
    }

    function enqueueTextureUpload(tile) {
      if (renderer !== "webgl" || !tile || !tile.imgLoaded || tile.textureLoaded || tile.textureQueued) {
        return;
      }
      tile.textureQueued = true;
      textureQueue.push(tile);
      scheduleTextureUpload();
    }

    function scheduleTextureUpload() {
      if (renderer !== "webgl" || uploadScheduled || !textureQueue.length) {
        return;
      }
      uploadScheduled = true;
      if (window.requestIdleCallback) {
        window.requestIdleCallback(processTextureQueue, { timeout: 120 });
      } else {
        window.setTimeout(processTextureQueue, 0);
      }
    }

    function processTextureQueue(deadline) {
      uploadScheduled = false;
      if (renderer !== "webgl") return;
      const batchLimit = startLoaded ? uploadsPerIdleAfterStart : uploadsPerIdleBeforeStart;
      let uploaded = 0;
      while (uploaded < batchLimit && textureQueue.length && !(deadline && deadline.timeRemaining && deadline.timeRemaining() < 2)) {
        const tile = textureQueue.shift();
        if (tile && tile.imgLoaded && !tile.textureLoaded) {
          tile.loadTexture();
          uploaded++;
        }
      }
      if (textureQueue.length) {
        scheduleTextureUpload();
      }
    }

    function preloadTiles(delta) {
      const direction = delta >= 0 ? 1 : -1;
      let ahead = preloadAheadMin + Math.ceil(Math.abs(delta) * 30);
      if (ahead > preloadAheadMax) {
        ahead = preloadAheadMax;
      }
      for (let offset = -preloadBehind; offset < visibleSteps + ahead; offset++) {
        const index = wrapTileIndex(Math.floor(position) + offset * direction);
        const tile = tiles[index];
        if (tile && !tile.imgLoaded && !tile.imgLoading) {
          tile.loadImage();
        } else if (tile && renderer === "webgl" && tile.imgLoaded && !tile.textureLoaded) {
          enqueueTextureUpload(tile);
        }
      }
    }

    function checkStartLoaded() {
      if (startLoaded) return;
      startLoaded = true;
      for (let step = 0; step < visibleSteps; step++) {
        const index = wrapTileIndex(Math.floor(position) + step);
        const tile = tiles[index];
        if (!tile || !tile.imgLoaded || (renderer === "webgl" && !tile.textureLoaded)) {
          startLoaded = false;
        }
      }
      if (startLoaded) {
        bodyElement.classList.add("startloaded");
      }
    }

    class ZoomTile {
      static positionBuffer = null;

      constructor(src, index) {
        this.index = index;
        this.imgLoaded = false;
        this.imgLoading = false;
        this.textureLoaded = false;
        this.textureQueued = false;
        this.imgSrc = src;
        this.image = new Image();
        this.bitmap = null;
        this.samplePixels = null;
        this.sourceWidth = 1;
        this.sourceHeight = 1;
        this.image.decoding = "async";
        if (renderer === "webgl" && !ZoomTile.positionBuffer) {
          ZoomTile.positionBuffer = gl.createBuffer();
          gl.bindBuffer(gl.ARRAY_BUFFER, ZoomTile.positionBuffer);
          gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
        }
      }

      buildSampleCache(source) {
        if (!pixelSamplingAllowed || this.samplePixels || !scratchCtx || !source) return;
        try {
          scratchCtx.clearRect(0, 0, SAMPLE_W, SAMPLE_H);
          scratchCtx.drawImage(source, 0, 0, SAMPLE_W, SAMPLE_H);
          this.samplePixels = scratchCtx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
        } catch {
          pixelSamplingAllowed = false;
        }
      }

      sampleAtLocalUv(u, v) {
        if (!this.samplePixels) return null;
        const px = clamp(Math.floor(u * SAMPLE_W), 0, SAMPLE_W - 1);
        const py = clamp(Math.floor(v * SAMPLE_H), 0, SAMPLE_H - 1);
        const idx = (py * SAMPLE_W + px) * 4;
        const r = this.samplePixels[idx];
        const g = this.samplePixels[idx + 1];
        const b = this.samplePixels[idx + 2];
        const rx = Math.min(SAMPLE_W - 1, px + 1);
        const by = Math.min(SAMPLE_H - 1, py + 1);
        const idxR = (py * SAMPLE_W + rx) * 4;
        const idxB = (by * SAMPLE_W + px) * 4;
        const diffR = Math.abs(r - this.samplePixels[idxR]) + Math.abs(g - this.samplePixels[idxR + 1]) + Math.abs(b - this.samplePixels[idxR + 2]);
        const diffB = Math.abs(r - this.samplePixels[idxB]) + Math.abs(g - this.samplePixels[idxB + 1]) + Math.abs(b - this.samplePixels[idxB + 2]);
        const edge = clamp((diffR + diffB) / 420, 0, 1);
        const hsl = rgbToHsl(r, g, b);
        return { r, g, b, h: hsl.h, s: hsl.s, l: hsl.l, edge };
      }

      loadImage() {
        if (this.imgLoaded || this.imgLoading) return;
        this.imgLoading = true;
        if (renderer === "webgl" && window.createImageBitmap && window.fetch) {
          fetch(this.imgSrc, { cache: "force-cache" })
            .then((response) => {
              if (!response.ok) throw new Error("Image fetch failed");
              return response.blob();
            })
            .then((blob) => createImageBitmap(blob))
            .then((bitmap) => {
              this.bitmap = bitmap;
              this.buildSampleCache(bitmap);
              this.onImageLoaded(bitmap.width, bitmap.height);
            })
            .catch(() => {
              this.imgLoading = false;
              this.loadImageFallback();
            });
        } else {
          this.loadImageFallback();
        }
      }

      loadImageFallback() {
        if (this.imgLoaded) return;
        this.image.onload = () => {
          this.buildSampleCache(this.image);
          this.onImageLoaded(this.image.width, this.image.height);
        };
        this.image.src = this.imgSrc;
        this.imgLoading = true;
      }

      onImageLoaded(width, height) {
        window.setTimeout(() => {
          this.imgLoading = false;
          this.imgLoaded = true;
          this.sourceWidth = width || 1;
          this.sourceHeight = height || 1;
          loadedCount++;
          if (loadedCount === 1) {
            imageWidth = width;
            imageHeight = height;
            updateLayout();
          }
          checkStartLoaded();
          if (renderer === "webgl") {
            enqueueTextureUpload(this);
          }
        }, 0);
      }

      loadTexture() {
        if (!this.imgLoaded || this.textureLoaded) {
          this.textureQueued = false;
          return;
        }
        const source = this.bitmap || this.image;
        if (!source) {
          this.textureQueued = false;
          return;
        }
        this.texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, source);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        if (useMipmaps) {
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
          gl.generateMipmap(gl.TEXTURE_2D);
        } else {
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        }
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        this.textureLoaded = true;
        this.textureQueued = false;
        if (this.bitmap && this.bitmap.close) {
          this.bitmap.close();
          this.bitmap = null;
        }
        checkStartLoaded();
      }

      setPosition(x, y, width, height) {
        this.x = x;
        this.y = y;
        this.width = width;
        this.height = height;
      }

      draw() {
        if (!this.texture) return;
        gl.useProgram(tileProgram);
        const transform = [this.width, 0, 0, 0, this.height, 0, this.x, this.y, 1];
        gl.uniformMatrix3fv(tileLocations.uTransformationMatrix, false, transform);
        gl.enableVertexAttribArray(tileLocations.aVertexPosition);
        gl.bindBuffer(gl.ARRAY_BUFFER, ZoomTile.positionBuffer);
        gl.vertexAttribPointer(tileLocations.aVertexPosition, 2, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(tileLocations.aTextureCoord);
        gl.bindBuffer(gl.ARRAY_BUFFER, ZoomTile.positionBuffer);
        gl.vertexAttribPointer(tileLocations.aTextureCoord, 2, gl.FLOAT, false, 0, 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.uniform1i(tileLocations.uSampler, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    }

    function createTiles() {
      tiles = [];
      for (let index = 0; index < imageArray.length; index++) {
        const src = isFileProtocol ? imageArray[index] : imageArray[index] + "?" + version;
        tiles.push(new ZoomTile(src, index));
      }
    }

    function samplePaintingAtNormalized(nx, ny) {
      const cx = nx * canvasWidth;
      const cy = ny * canvasHeight;
      for (let i = lastActiveDrawList.length - 1; i >= 0; i--) {
        const item = lastActiveDrawList[i];
        if (
          cx >= item.x &&
          cx <= item.x + item.width &&
          cy >= item.y &&
          cy <= item.y + item.height
        ) {
          const u = (cx - item.x) / item.width;
          const v = (cy - item.y) / item.height;
          const sampled = item.tile.sampleAtLocalUv(u, v);
          if (sampled) return sampled;
        }
      }
      return fallbackSample(nx, ny, position);
    }

    function spawnSpores(nx, ny, sample, count, burstSpeed, kind = "mixed") {
      for (let i = 0; i < count; i++) {
        if (spores.length > 320) spores.shift();
        const angle = Math.random() * Math.PI * 2;
        const spd = (0.018 + Math.random() * 0.11) * burstSpeed;
        const hueJitter = (Math.random() - 0.5) * 44;
        const isPetal = kind === "petal" || (kind === "mixed" && Math.random() > 0.45);
        spores.push({
          x: nx + (Math.random() - 0.5) * 0.014,
          y: ny + (Math.random() - 0.5) * 0.014,
          vx: Math.cos(angle) * spd,
          vy: Math.sin(angle) * spd,
          size: isPetal ? 2.4 + Math.random() * 4.4 : 1.5 + Math.random() * 3.0,
          h: (sample.h + hueJitter + 360) % 360,
          s: clamp(sample.s + 0.26, 0.6, 1),
          l: clamp(sample.l + 0.18, 0.58, 0.88),
          life: 1,
          decay: 0.19 + Math.random() * 0.26,
          phase: Math.random() * Math.PI * 2,
          spin: (Math.random() - 0.5) * 4.2,
          petal: isPetal,
          trail: []
        });
      }
    }

    function spawnTendrils(nx, ny, sample, count) {
      for (let i = 0; i < count; i++) {
        if (tendrils.length > 48) tendrils.shift();
        const baseAngle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.45;
        tendrils.push({
          points: [{ x: nx, y: ny }],
          angle: baseAngle,
          turn: (Math.random() - 0.5) * 4.2,
          speed: 0.09 + Math.random() * 0.09,
          h: (sample.h + (Math.random() - 0.5) * 45 + 360) % 360,
          s: clamp(sample.s + 0.25, 0.6, 1),
          l: clamp(sample.l + 0.22, 0.62, 0.88),
          life: 1,
          growTime: 0.45 + Math.random() * 0.35,
          age: 0
        });
      }
    }

    function addRipple(nx, ny, intensity = 1, options = {}) {
      const sample = samplePaintingAtNormalized(nx, ny);
      pointer.sample = sample;
      if (ripples.length >= MAX_RIPPLES) {
        ripples.shift();
      }
      ripples.push({ x: nx, y: ny, age: 0, intensity });

      if (blooms.length >= 18) blooms.shift();
      const isSupernova = Boolean(options.supernova);
      const isReverse = intensity < 0;
      blooms.push({
        x: nx,
        y: ny,
        radius: isReverse ? 140 : 8,
        growth: isReverse ? -220 : isSupernova ? 260 : 185,
        petals: isSupernova ? 12 : 6 + Math.floor(sample.edge * 4),
        rotation: Math.random() * Math.PI * 2,
        h: sample.h,
        s: clamp(sample.s + 0.25, 0.6, 1),
        l: clamp(sample.l + 0.2, 0.58, 0.88),
        life: 1,
        decay: isSupernova ? 0.56 : 0.76,
        supernova: isSupernova
      });

      const sporeCount = isSupernova ? 46 : isReverse ? 18 : 22;
      spawnSpores(nx, ny, sample, sporeCount, isSupernova ? 1.85 : isReverse ? 0.6 : 1.25);
      spawnTendrils(nx, ny, sample, isSupernova ? 10 : 5);
      if (audio) {
        if (isSupernova) audio.triggerSupernova(sample, nx, Math.abs(intensity));
        else if (isReverse) audio.triggerEcho(sample, nx);
        else audio.triggerResonance(sample, nx, "awaken");
      }
    }

    function addTrailPoint(nx, ny, speedNorm) {
      if (trails.length >= MAX_TRAILS) {
        trails.shift();
      }
      trails.push({
        x: nx,
        y: ny,
        life: 1,
        energy: clamp(0.4 + speedNorm * 1.4, 0.4, 1.8)
      });
    }

    function beginWebGLPass() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, compositeFramebuffer);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(tileProgram);
      const projection = orthoMatrix(0, canvasWidth, canvasHeight, 0, -1, 1);
      gl.uniformMatrix4fv(tileLocations.uProjectionMatrix, false, new Float32Array(projection));
    }

    function finishWebGLPostProcess() {
      for (let i = 0; i < MAX_RIPPLES; i++) {
        const rp = ripples[i];
        const base = i * 4;
        if (rp) {
          rippleUniformData[base] = rp.x;
          rippleUniformData[base + 1] = 1 - rp.y;
          rippleUniformData[base + 2] = rp.age;
          rippleUniformData[base + 3] = rp.intensity;
        } else {
          rippleUniformData[base] = 0;
          rippleUniformData[base + 1] = 0;
          rippleUniformData[base + 2] = 0;
          rippleUniformData[base + 3] = 0;
        }
      }

      for (let i = 0; i < MAX_TRAILS; i++) {
        const tr = trails[i];
        const base = i * 4;
        if (tr) {
          trailUniformData[base] = tr.x;
          trailUniformData[base + 1] = 1 - tr.y;
          trailUniformData[base + 2] = tr.life;
          trailUniformData[base + 3] = tr.energy;
        } else {
          trailUniformData[base] = 0;
          trailUniformData[base + 1] = 0;
          trailUniformData[base + 2] = 0;
          trailUniformData[base + 3] = 0;
        }
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(fxProgram);
      gl.enableVertexAttribArray(fxLocations.aVertexPosition);
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
      gl.vertexAttribPointer(fxLocations.aVertexPosition, 2, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(fxLocations.aTextureCoord);
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
      gl.vertexAttribPointer(fxLocations.aTextureCoord, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, compositeTexture);
      gl.uniform1i(fxLocations.uSampler, 0);
      gl.uniform2f(fxLocations.uResolution, canvas.width, canvas.height);
      gl.uniform2f(fxLocations.uTexelSize, texelWidth, texelHeight);
      gl.uniform1f(fxLocations.uTime, elapsedTime);
      gl.uniform2f(fxLocations.uPointer, pointer.x, 1 - pointer.y);
      gl.uniform2f(fxLocations.uPointerVel, pointer.vx, -pointer.vy);
      gl.uniform1f(fxLocations.uPointerActive, pointer.active);
      gl.uniform1f(fxLocations.uHoldAmount, pointer.hold);
      gl.uniform1f(fxLocations.uWarpEnergy, warpEnergy);
      gl.uniform4fv(fxLocations.uRipples, rippleUniformData);
      gl.uniform4fv(fxLocations.uTrails, trailUniformData);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    function updateAndDrawOverlay(dtSec, zoomFactor) {
      if (!overlayCtx || !overlayCanvas) return;
      overlayCtx.setTransform(devicePixelRatioValue, 0, 0, devicePixelRatioValue, 0, 0);
      overlayCtx.clearRect(0, 0, viewportWidth, viewportHeight);
      overlayCtx.globalCompositeOperation = "lighter";

      const px = pointer.x * viewportWidth;
      const py = pointer.y * viewportHeight;

      // Update zoom-space embedded ripples
      for (let i = ripples.length - 1; i >= 0; i--) {
        const rp = ripples[i];
        rp.x = 0.5 + (rp.x - 0.5) * zoomFactor;
        rp.y = 0.5 + (rp.y - 0.5) * zoomFactor;
        rp.age += dtSec * 1.05;
        rp.intensity *= Math.pow(0.32, dtSec);
        if (Math.abs(rp.intensity) < 0.015 || rp.age > 2.6) {
          ripples.splice(i, 1);
        }
      }

      // Update zoom-space embedded trails
      for (let i = trails.length - 1; i >= 0; i--) {
        const tr = trails[i];
        tr.x = 0.5 + (tr.x - 0.5) * zoomFactor;
        tr.y = 0.5 + (tr.y - 0.5) * zoomFactor;
        tr.life -= dtSec * 0.92;
        if (tr.life <= 0) {
          trails.splice(i, 1);
        }
      }

      // Silky tapered bioluminescent cursor ribbon in zoom-space
      const ribbonStreams = [ribbonPoints, secondaryRibbonPoints];
      for (let sIdx = 0; sIdx < ribbonStreams.length; sIdx++) {
        const stream = ribbonStreams[sIdx];
        for (let i = stream.length - 1; i >= 0; i--) {
          const pt = stream[i];
          pt.x = 0.5 + (pt.x - 0.5) * zoomFactor;
          pt.y = 0.5 + (pt.y - 0.5) * zoomFactor;
          pt.life -= dtSec * 1.85;
          if (pt.life <= 0) stream.splice(i, 1);
        }
        if (stream.length > 2) {
          overlayCtx.lineCap = "round";
          overlayCtx.lineJoin = "round";
          for (let i = 1; i < stream.length; i++) {
            const a = stream[i - 1];
            const b = stream[i];
            const t = b.life;
            const ax = a.x * viewportWidth;
            const ay = a.y * viewportHeight;
            const bx = b.x * viewportWidth;
            const by = b.y * viewportHeight;
            if (Math.hypot(bx - ax, by - ay) > 220) continue;
            overlayCtx.strokeStyle = hslToRgbaString(b.h, b.s, b.l, t * 0.52);
            overlayCtx.lineWidth = Math.max(0.8, t * 6.5);
            overlayCtx.beginPath();
            overlayCtx.moveTo(ax, ay);
            overlayCtx.lineTo(bx, by);
            overlayCtx.stroke();

            overlayCtx.strokeStyle = hslToRgbaString((b.h + 40) % 360, 0.95, 0.9, t * 0.35);
            overlayCtx.lineWidth = Math.max(0.5, t * 2.1);
            overlayCtx.beginPath();
            overlayCtx.moveTo(ax, ay);
            overlayCtx.lineTo(bx, by);
            overlayCtx.stroke();
          }
        }
      }

      // Growing botanical light-tendrils locked in zoom-space
      for (let i = tendrils.length - 1; i >= 0; i--) {
        const td = tendrils[i];
        td.age += dtSec;
        td.life -= dtSec * 0.68;
        for (let j = 0; j < td.points.length; j++) {
          td.points[j].x = 0.5 + (td.points[j].x - 0.5) * zoomFactor;
          td.points[j].y = 0.5 + (td.points[j].y - 0.5) * zoomFactor;
        }
        if (td.age < td.growTime && td.points.length < 18) {
          const head = td.points[td.points.length - 1];
          td.angle += td.turn * dtSec + Math.sin(elapsedTime * 6 + i) * 0.08;
          td.points.push({
            x: head.x + Math.cos(td.angle) * td.speed * dtSec,
            y: head.y + Math.sin(td.angle) * td.speed * dtSec
          });
        }
        if (td.life <= 0) {
          tendrils.splice(i, 1);
          continue;
        }
        if (td.points.length > 1) {
          overlayCtx.beginPath();
          overlayCtx.moveTo(td.points[0].x * viewportWidth, td.points[0].y * viewportHeight);
          for (let j = 1; j < td.points.length; j++) {
            overlayCtx.lineTo(td.points[j].x * viewportWidth, td.points[j].y * viewportHeight);
          }
          overlayCtx.strokeStyle = hslToRgbaString(td.h, td.s, td.l, td.life * 0.58);
          overlayCtx.lineWidth = Math.max(0.7, td.life * 2.2);
          overlayCtx.stroke();

          const tip = td.points[td.points.length - 1];
          overlayCtx.fillStyle = hslToRgbaString((td.h + 30) % 360, 1, 0.9, td.life * 0.85);
          overlayCtx.beginPath();
          overlayCtx.arc(tip.x * viewportWidth, tip.y * viewportHeight, 2.2 * td.life, 0, Math.PI * 2);
          overlayCtx.fill();
        }
      }

      // Ornate harmonic bloom mandalas & resonance rings in zoom-space
      for (let i = blooms.length - 1; i >= 0; i--) {
        const bl = blooms[i];
        bl.x = 0.5 + (bl.x - 0.5) * zoomFactor;
        bl.y = 0.5 + (bl.y - 0.5) * zoomFactor;
        bl.radius = Math.max(2, bl.radius * zoomFactor + dtSec * bl.growth);
        bl.rotation += dtSec * (bl.supernova ? 0.9 : 0.55);
        bl.life -= dtSec * bl.decay;
        if (bl.life <= 0) {
          blooms.splice(i, 1);
          continue;
        }
        const rx = bl.x * viewportWidth;
        const ry = bl.y * viewportHeight;
        const fade = Math.sin(Math.min(1, bl.life) * Math.PI * 0.5);

        overlayCtx.beginPath();
        overlayCtx.arc(rx, ry, bl.radius, 0, Math.PI * 2);
        overlayCtx.strokeStyle = hslToRgbaString(bl.h, bl.s, bl.l, fade * 0.62);
        overlayCtx.lineWidth = (bl.supernova ? 2.4 : 1.5) * fade;
        overlayCtx.stroke();

        overlayCtx.beginPath();
        overlayCtx.arc(rx, ry, bl.radius * 0.68, 0, Math.PI * 2);
        overlayCtx.strokeStyle = hslToRgbaString((bl.h + 44) % 360, bl.s, 0.86, fade * 0.34);
        overlayCtx.lineWidth = 1.1 * fade;
        overlayCtx.stroke();

        // Blooming organic petal geometry
        overlayCtx.save();
        overlayCtx.translate(rx, ry);
        overlayCtx.rotate(bl.rotation);
        overlayCtx.strokeStyle = hslToRgbaString((bl.h + 22) % 360, bl.s, 0.88, fade * 0.38);
        overlayCtx.lineWidth = 1.0;
        const petalLen = bl.radius * 0.48;
        for (let p = 0; p < bl.petals; p++) {
          const a = (Math.PI * 2 * p) / bl.petals;
          const cx = Math.cos(a) * petalLen;
          const cy = Math.sin(a) * petalLen;
          overlayCtx.beginPath();
          overlayCtx.ellipse(cx, cy, petalLen * 0.42, petalLen * 0.14, a, 0, Math.PI * 2);
          overlayCtx.stroke();
        }
        overlayCtx.restore();
      }

      // Living spores / fireflies / petals embedded inside the zooming architecture
      for (let i = spores.length - 1; i >= 0; i--) {
        const sp = spores[i];
        sp.x = 0.5 + (sp.x - 0.5) * zoomFactor;
        sp.y = 0.5 + (sp.y - 0.5) * zoomFactor;

        if (pointer.hold > 0.05) {
          const dx = pointer.x - sp.x;
          const dy = pointer.y - sp.y;
          const dist = Math.hypot(dx, dy) + 0.018;
          const pull = clamp(0.45 / (dist + 0.12), 0.18, 1.4);
          sp.vx += ((dx / dist) * 0.34 - (dy / dist) * 0.52) * pull * pointer.hold * dtSec;
          sp.vy += ((dy / dist) * 0.34 + (dx / dist) * 0.52) * pull * pointer.hold * dtSec;
        } else if (pointer.active > 0.1) {
          const dx = sp.x - pointer.x;
          const dy = sp.y - pointer.y;
          const dist = Math.hypot(dx, dy);
          if (dist < 0.2 && dist > 0.001) {
            const push = (0.2 - dist) * 0.45 * dtSec;
            sp.vx += (dx / dist) * push + pointer.vx * 0.32;
            sp.vy += (dy / dist) * push + pointer.vy * 0.32;
          }
        }

        sp.x += sp.vx * dtSec + Math.sin(elapsedTime * 2.4 + sp.phase) * 0.006 * dtSec;
        sp.y += sp.vy * dtSec + Math.cos(elapsedTime * 2.0 + sp.phase) * 0.006 * dtSec;
        sp.vx *= Math.pow(pointer.hold > 0.1 ? 0.58 : 0.28, dtSec);
        sp.vy *= Math.pow(pointer.hold > 0.1 ? 0.58 : 0.28, dtSec);
        sp.size = clamp(sp.size * Math.pow(zoomFactor, 0.42), 1, 15);
        sp.life -= sp.decay * dtSec;

        if (sp.life <= 0 || sp.x < -0.15 || sp.x > 1.15 || sp.y < -0.15 || sp.y > 1.15) {
          spores.splice(i, 1);
          continue;
        }

        const sx = sp.x * viewportWidth;
        const sy = sp.y * viewportHeight;
        sp.trail.push({ x: sx, y: sy });
        if (sp.trail.length > 6) sp.trail.shift();

        const alpha = Math.sin(Math.min(1, sp.life) * Math.PI) * 0.9;

        if (sp.trail.length > 1) {
          overlayCtx.beginPath();
          overlayCtx.moveTo(sp.trail[0].x, sp.trail[0].y);
          for (let tIdx = 1; tIdx < sp.trail.length; tIdx++) {
            overlayCtx.lineTo(sp.trail[tIdx].x, sp.trail[tIdx].y);
          }
          overlayCtx.strokeStyle = hslToRgbaString(sp.h, sp.s, 0.86, alpha * 0.36);
          overlayCtx.lineWidth = Math.max(0.6, sp.size * 0.32);
          overlayCtx.stroke();
        }

        const glow = overlayCtx.createRadialGradient(sx, sy, 0, sx, sy, sp.size * 3.6);
        glow.addColorStop(0, hslToRgbaString(sp.h, sp.s, Math.min(0.95, sp.l + 0.14), alpha));
        glow.addColorStop(0.45, hslToRgbaString(sp.h, sp.s, sp.l, alpha * 0.38));
        glow.addColorStop(1, hslToRgbaString(sp.h, sp.s, sp.l, 0));
        overlayCtx.fillStyle = glow;
        overlayCtx.beginPath();
        overlayCtx.arc(sx, sy, sp.size * 3.6, 0, Math.PI * 2);
        overlayCtx.fill();

        if (sp.petal) {
          overlayCtx.save();
          overlayCtx.translate(sx, sy);
          overlayCtx.rotate(elapsedTime * sp.spin + sp.phase);
          overlayCtx.fillStyle = hslToRgbaString(sp.h, sp.s, 0.92, alpha * 0.9);
          overlayCtx.beginPath();
          overlayCtx.ellipse(0, 0, sp.size * 1.45, sp.size * 0.55, 0, 0, Math.PI * 2);
          overlayCtx.fill();
          overlayCtx.restore();
        }
      }

      // Delicate bioluminescent neural filaments linking cursor & nearby spores
      if (pointer.active > 0.08 && spores.length > 0) {
        const maxLinkDist = 145 + pointer.hold * 90;
        overlayCtx.lineWidth = 0.9;
        for (let i = 0; i < spores.length; i++) {
          const sp = spores[i];
          const sx = sp.x * viewportWidth;
          const sy = sp.y * viewportHeight;
          const dist = Math.hypot(sx - px, sy - py);
          if (dist < maxLinkDist) {
            const strength = (1 - dist / maxLinkDist) * pointer.active * sp.life * (0.42 + pointer.hold * 0.35);
            overlayCtx.strokeStyle = hslToRgbaString(sp.h, sp.s, 0.86, strength);
            overlayCtx.beginPath();
            overlayCtx.moveTo(px, py);
            const mx = (px + sx) * 0.5 + Math.sin(elapsedTime * 3 + sp.phase) * 14;
            const my = (py + sy) * 0.5 + Math.cos(elapsedTime * 3 + sp.phase) * 14;
            overlayCtx.quadraticCurveTo(mx, my, sx, sy);
            overlayCtx.stroke();
          }
        }
      }

      // Custom living organic cursor (fades gently when completely still)
      const cursorVis = pointer.active * clamp(1 - (pointer.idleTime - 1.6) * 0.8, 0, 1);
      if (cursorVis > 0.02) {
        const sample = pointer.sample;
        const auraRadius = 46 + pointer.hold * 64 + sample.edge * 24;
        const grad = overlayCtx.createRadialGradient(px, py, 2, px, py, auraRadius);
        grad.addColorStop(0, hslToRgbaString(sample.h, clamp(sample.s + 0.25, 0.55, 1), 0.88, 0.28 * cursorVis));
        grad.addColorStop(0.45, hslToRgbaString((sample.h + 36) % 360, 0.88, 0.68, 0.11 * cursorVis));
        grad.addColorStop(1, "rgba(255, 255, 255, 0)");
        overlayCtx.fillStyle = grad;
        overlayCtx.beginPath();
        overlayCtx.arc(px, py, auraRadius, 0, Math.PI * 2);
        overlayCtx.fill();

        const ringR = 8 + pointer.hold * 26 + Math.sin(elapsedTime * 5.2) * 1.6;
        overlayCtx.beginPath();
        overlayCtx.arc(px, py, ringR, 0, Math.PI * 2);
        overlayCtx.strokeStyle = hslToRgbaString(sample.h, clamp(sample.s + 0.28, 0.6, 1), 0.9, 0.58 * cursorVis);
        overlayCtx.lineWidth = 1.2;
        overlayCtx.stroke();

        // Tiny orbiting sparks around the living cursor
        const orbitCount = pointer.hold > 0.1 ? 6 : 3;
        for (let k = 0; k < orbitCount; k++) {
          const a = elapsedTime * (2.2 + pointer.hold * 3.5) + (Math.PI * 2 * k) / orbitCount;
          const ox = px + Math.cos(a) * (ringR + 4);
          const oy = py + Math.sin(a) * (ringR + 4);
          overlayCtx.fillStyle = hslToRgbaString((sample.h + k * 28) % 360, 0.95, 0.92, 0.78 * cursorVis);
          overlayCtx.beginPath();
          overlayCtx.arc(ox, oy, 1.5 + pointer.hold * 1.1, 0, Math.PI * 2);
          overlayCtx.fill();
        }
      }

      // Matching organic bioluminescent aura for a second hand in camera view
      if (secondaryHand.active > 0.03) {
        const shx = secondaryHand.x * viewportWidth;
        const shy = secondaryHand.y * viewportHeight;
        const sSample = secondaryHand.sample;
        const sVis = secondaryHand.active;
        const sAura = 42 + secondaryHand.hold * 54 + sSample.edge * 20;
        const sGrad = overlayCtx.createRadialGradient(shx, shy, 2, shx, shy, sAura);
        sGrad.addColorStop(0, hslToRgbaString(sSample.h, clamp(sSample.s + 0.25, 0.55, 1), 0.88, 0.24 * sVis));
        sGrad.addColorStop(0.45, hslToRgbaString((sSample.h + 36) % 360, 0.88, 0.68, 0.1 * sVis));
        sGrad.addColorStop(1, "rgba(255, 255, 255, 0)");
        overlayCtx.fillStyle = sGrad;
        overlayCtx.beginPath();
        overlayCtx.arc(shx, shy, sAura, 0, Math.PI * 2);
        overlayCtx.fill();

        const sRingR = 7 + secondaryHand.hold * 22 + Math.sin(elapsedTime * 5.2 + 1.4) * 1.5;
        overlayCtx.beginPath();
        overlayCtx.arc(shx, shy, sRingR, 0, Math.PI * 2);
        overlayCtx.strokeStyle = hslToRgbaString(sSample.h, clamp(sSample.s + 0.28, 0.6, 1), 0.9, 0.52 * sVis);
        overlayCtx.lineWidth = 1.1;
        overlayCtx.stroke();
      }

      overlayCtx.globalCompositeOperation = "source-over";
    }

    function renderFrame(timestamp) {
      let deltaMs = 0;
      if (lastTimestamp) {
        deltaMs = Math.min(timestamp - lastTimestamp, 100);
      }
      lastTimestamp = timestamp;
      const dtSec = deltaMs / 1000;
      elapsedTime += dtSec;

      // Smooth pointer interpolation & hold time dilation
      const prevX = pointer.x;
      const prevY = pointer.y;
      const smooth = 1 - Math.exp(-dtSec * 16);
      pointer.x += (pointer.targetX - pointer.x) * smooth;
      pointer.y += (pointer.targetY - pointer.y) * smooth;
      pointer.vx = (pointer.x - prevX) * 0.65 + pointer.vx * 0.35;
      pointer.vy = (pointer.y - prevY) * 0.65 + pointer.vy * 0.35;
      pointer.active += ((pointer.isInside ? 1 : 0) - pointer.active) * (1 - Math.exp(-dtSec * 6));
      pointer.hold += ((pointer.isDown ? 1 : 0) - pointer.hold) * (1 - Math.exp(-dtSec * 7));
      if (pointer.isDown) {
        pointer.holdDuration += dtSec;
        pointer.idleTime = 0;
      } else {
        pointer.idleTime += dtSec;
      }

      secondaryHand.x += (secondaryHand.targetX - secondaryHand.x) * smooth;
      secondaryHand.y += (secondaryHand.targetY - secondaryHand.y) * smooth;
      secondaryHand.active += ((secondaryHand.isInside ? 1 : 0) - secondaryHand.active) * (1 - Math.exp(-dtSec * 6));
      secondaryHand.hold += ((secondaryHand.isDown ? 1 : 0) - secondaryHand.hold) * (1 - Math.exp(-dtSec * 7));

      // Gentle organic parallax steering as pointer explores the painting
      if (pointer.isInside) {
        const parallaxStrength = pointer.isDown ? 0.088 : 0.036;
        targetPanX = (0.5 - pointer.x) * baseWidth * parallaxStrength;
        targetPanY = (0.5 - pointer.y) * baseHeight * parallaxStrength;
      } else {
        targetPanX = 0;
        targetPanY = 0;
      }
      const panEase = 1 - Math.exp(-dtSec * 4.5);
      panX += (targetPanX - panX) * panEase;
      panY += (targetPanY - panY) * panEase;

      // Holding slows zoom time so you can sculpt the spacetime vortex
      const timeDilation = 1 - pointer.hold * 0.8;

      let deltaPosition = 0;
      const stepUnit = 3e-4 * deltaMs;
      if (wheelNudge !== 0) {
        deltaPosition += wheelNudge / 1500;
        warpEnergy = Math.min(1.2, warpEnergy + Math.abs(wheelNudge) / 950);
        wheelNudge = 0;
      }
      warpEnergy *= Math.pow(0.06, dtSec);
      if (touchVelocity !== 0) {
        deltaPosition += touchVelocity / 2000;
        if (!touching) {
          touchVelocity *= 0.9;
        }
      }
      if (directions.up && keyboardMovementEnabled) {
        deltaPosition += stepUnit * 10;
      } else if (directions.down && keyboardMovementEnabled) {
        deltaPosition -= stepUnit * 10;
      } else if (playing) {
        deltaPosition += (stepUnit / 8) * speed * timeDilation;
      }

      preloadTiles(deltaPosition);
      const ready = checkVisibleReady(deltaPosition);

      let actualDelta = 0;
      if (ready) {
        actualDelta = deltaPosition;
        position += deltaPosition;
        if (position < 0) position += tiles.length;
        if (position >= tiles.length) position -= tiles.length;
      }

      // Render infinite zoom tiles with gentle parallax & zoom-consistent framing
      if (renderer === "webgl") {
        beginWebGLPass();
      } else {
        ctx2d.clearRect(0, 0, canvas.width, canvas.height);
      }

      const activeTiles = [];
      for (let step = 0; step < visibleSteps; step++) {
        const index = (Math.floor(position) + step) % tiles.length;
        if (!Number.isNaN(index)) {
          activeTiles.push(tiles[index]);
        }
      }

      const parallaxOverscan = 1.08;
      let scale = Math.pow(2, position % 1) * parallaxOverscan;
      lastActiveDrawList = [];
      for (let step = 0; step < activeTiles.length; step++) {
        const depthParallax = 1 + step * 0.22;
        const drawWidth = baseWidth * scale;
        const drawHeight = baseHeight * scale;
        const drawX = centerX - drawWidth / 2 + panX * depthParallax;
        const drawY = centerY - drawHeight / 2 + panY * depthParallax;
        const tile = activeTiles[step];
        if (tile && tile.imgLoaded) {
          tile.setPosition(drawX, drawY, drawWidth, drawHeight);
          lastActiveDrawList.push({ tile, x: drawX, y: drawY, width: drawWidth, height: drawHeight });
          if (renderer === "webgl") {
            tile.draw();
          } else {
            ctx2d.drawImage(tile.image, drawX, drawY, drawWidth, drawHeight);
          }
        }
        scale *= 0.5;
      }

      if (renderer === "webgl") {
        finishWebGLPostProcess();
      }

      // Living spores while holding + gentle autonomous dream motes from the depth tunnel
      if (pointer.isInside && pointer.hold > 0.15 && Math.random() < 0.65) {
        const sample = samplePaintingAtNormalized(pointer.x, pointer.y);
        pointer.sample = sample;
        spawnSpores(pointer.x, pointer.y, sample, 2, 0.65);
      } else if (startLoaded && spores.length < 18 && Math.random() < 0.045) {
        const rx = 0.36 + Math.random() * 0.28;
        const ry = 0.36 + Math.random() * 0.28;
        const sample = samplePaintingAtNormalized(rx, ry);
        spawnSpores(rx, ry, sample, 1, 0.25, "mixed");
      }

      const zoomFactor = Math.pow(2, actualDelta);
      updateAndDrawOverlay(dtSec, zoomFactor);

      if (audio) {
        audio.updateAtmosphere(actualDelta * 60, pointer.hold, pointer.sample.h);
      }

      window.requestAnimationFrame(renderFrame);
    }

    function syncCanvasResolution() {
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;
      if (overlayCanvas) {
        overlayCanvas.width = canvasWidth;
        overlayCanvas.height = canvasHeight;
      }
      if (renderer === "webgl") {
        resizeCompositeFramebuffer();
      }
    }

    function debounce(fn, delayMs) {
      let timerId;
      return function (...args) {
        clearTimeout(timerId);
        timerId = setTimeout(() => {
          fn.apply(this, args);
        }, delayMs);
      };
    }

    const debouncedSyncResolution = debounce(syncCanvasResolution, 200);

    function updateLayout() {
      devicePixelRatioValue = window.devicePixelRatio !== undefined ? window.devicePixelRatio : 1;
      viewportWidth = window.innerWidth;
      viewportHeight = window.innerHeight;
      canvasWidth = viewportWidth * devicePixelRatioValue;
      canvasHeight = viewportHeight * devicePixelRatioValue;
      centerX = canvasWidth / 2;
      centerY = canvasHeight / 2;
      if (imageWidth && imageHeight) {
        if (canvasWidth > canvasHeight * (imageWidth / imageHeight)) {
          baseWidth = canvasWidth;
          baseHeight = canvasWidth * (imageHeight / imageWidth);
        } else {
          baseWidth = canvasHeight * (imageWidth / imageHeight);
          baseHeight = canvasHeight;
        }
      } else {
        baseWidth = canvasWidth;
        baseHeight = canvasHeight;
      }
      isPortrait = canvasHeight > canvasWidth;
      if (renderer === "webgl") {
        debouncedSyncResolution();
      } else {
        syncCanvasResolution();
      }
    }

    window.addEventListener("resize", function () {
      updateLayout();
    });

    let lastMoveSampleAt = 0;
    let lastSecondarySampleAt = 0;
    function applyPrimaryNormalizedMove(nx, ny) {
      const moveDist = Math.hypot(nx - pointer.targetX, ny - pointer.targetY);
      pointer.targetX = nx;
      pointer.targetY = ny;
      pointer.isInside = true;
      pointer.idleTime = 0;

      const now = performance.now();
      if (moveDist > 0.006) {
        addTrailPoint(nx, ny, moveDist * 22);
        const curSample = pointer.sample;
        ribbonPoints.push({
          x: nx,
          y: ny,
          h: curSample.h,
          s: clamp(curSample.s + 0.25, 0.6, 1),
          l: clamp(curSample.l + 0.22, 0.62, 0.9),
          life: 1
        });
        if (ribbonPoints.length > 42) ribbonPoints.shift();
      }
      if (now - lastMoveSampleAt > 42) {
        lastMoveSampleAt = now;
        const sample = samplePaintingAtNormalized(nx, ny);
        pointer.sample = sample;

        if (moveDist > 0.009) {
          const burstCount = pointer.isDown ? 3 : sample.edge > 0.2 ? 2 : 1;
          spawnSpores(nx, ny, sample, burstCount, 0.55 + moveDist * 12);
        }
        if (audio && moveDist > 0.014 && sample.edge > 0.2) {
          audio.triggerGlideSpark(sample, nx, clamp(moveDist * 24, 0.25, 1.6));
        }
      }
    }

    function onPointerMove(clientX, clientY) {
      lastDirectPointerAt = performance.now();
      handDrivingPointer = false;
      const nx = clamp(clientX / Math.max(viewportWidth, 1), 0, 1);
      const ny = clamp(clientY / Math.max(viewportHeight, 1), 0, 1);
      applyPrimaryNormalizedMove(nx, ny);
    }

    function onPointerDown(clientX, clientY, isSecondary = false) {
      lastDirectPointerAt = performance.now();
      handDrivingPointer = false;
      const nx = clamp(clientX / Math.max(viewportWidth, 1), 0, 1);
      const ny = clamp(clientY / Math.max(viewportHeight, 1), 0, 1);
      pointer.targetX = nx;
      pointer.targetY = ny;
      pointer.isInside = true;
      pointer.idleTime = 0;
      if (isSecondary) {
        addRipple(nx, ny, -1.25);
        wheelNudge -= 280;
      } else {
        directPointerDown = true;
        pointer.isDown = true;
        pointer.holdDuration = 0;
        addRipple(nx, ny, 1.18);
      }
    }

    function onPointerUp() {
      directPointerDown = false;
      if (pointer.isDown && pointer.holdDuration > 0.34) {
        const power = clamp(1.15 + pointer.holdDuration * 0.65, 1.2, 2.2);
        addRipple(pointer.x, pointer.y, power, { supernova: true });
      }
      pointer.isDown = false;
      pointer.holdDuration = 0;
    }

    function onPointerLeave() {
      directPointerDown = false;
      pointer.isInside = false;
      pointer.isDown = false;
      pointer.holdDuration = 0;
    }

    function updateSecondaryHand(state = {}) {
      if (!state.active) {
        secondaryHand.isInside = false;
        secondaryHand.isDown = false;
        return;
      }
      const nx = clamp(state.x, 0, 1);
      const ny = clamp(state.y, 0, 1);
      const moveDist = Math.hypot(nx - secondaryHand.targetX, ny - secondaryHand.targetY);
      secondaryHand.targetX = nx;
      secondaryHand.targetY = ny;
      secondaryHand.isInside = true;
      secondaryHand.isDown = Boolean(state.holding);

      const now = performance.now();
      if (moveDist > 0.007) {
        addTrailPoint(nx, ny, moveDist * 22);
        const curSample = secondaryHand.sample;
        secondaryRibbonPoints.push({
          x: nx,
          y: ny,
          h: curSample.h,
          s: clamp(curSample.s + 0.25, 0.6, 1),
          l: clamp(curSample.l + 0.22, 0.62, 0.9),
          life: 1
        });
        if (secondaryRibbonPoints.length > 38) secondaryRibbonPoints.shift();
      }
      if (now - lastSecondarySampleAt > 56) {
        lastSecondarySampleAt = now;
        const sample = samplePaintingAtNormalized(nx, ny);
        secondaryHand.sample = sample;
        if (moveDist > 0.01) {
          spawnSpores(nx, ny, sample, secondaryHand.isDown ? 2 : 1, 0.55 + moveDist * 10);
        }
      }
    }

    function updateHandPointer(state = {}) {
      const nx = clamp(state.x, 0, 1);
      const ny = clamp(state.y, 0, 1);
      const now = performance.now();
      // Yield primary pointer while user is actively using mouse/touch, route hand as secondary organic stream
      if (directPointerDown || now - lastDirectPointerAt < 1400) {
        handRoutedToSecondary = true;
        updateSecondaryHand({ active: true, x: nx, y: ny, holding: state.holding, speedNorm: state.speedNorm });
        return;
      }

      if (handRoutedToSecondary) {
        handRoutedToSecondary = false;
        secondaryHand.isInside = false;
        secondaryHand.isDown = false;
      }

      handDrivingPointer = true;
      applyPrimaryNormalizedMove(nx, ny);
      const nextHolding = Boolean(state.holding);
      if (nextHolding && !pointer.isDown) {
        pointer.isDown = true;
        pointer.holdDuration = 0;
      } else if (!nextHolding && pointer.isDown) {
        pointer.isDown = false;
        pointer.holdDuration = 0;
      }
    }

    function releaseHand() {
      if (handRoutedToSecondary) {
        handRoutedToSecondary = false;
        secondaryHand.isInside = false;
        secondaryHand.isDown = false;
      }
      if (!handDrivingPointer) return;
      handDrivingPointer = false;
      if (!directPointerDown && performance.now() - lastDirectPointerAt > 1400) {
        pointer.isInside = false;
        pointer.isDown = false;
        pointer.holdDuration = 0;
      }
    }

    updateLayout();
    syncCanvasResolution();
    createTiles();
    window.requestAnimationFrame(renderFrame);

    return {
      getState: () => ({
        speed,
        maxspeed: maxSpeed,
        playing,
        renderer,
        activeRipples: ripples.length,
        activeSpores: spores.length,
        activeBlooms: blooms.length
      }),
      setSpeed(nextSpeed) {
        speed = Math.max(-maxSpeed, Math.min(maxSpeed, Number(nextSpeed)));
      },
      setPlaying(nextPlaying) {
        playing = Boolean(nextPlaying);
      },
      onPointerMove,
      onPointerDown,
      onPointerUp,
      onPointerLeave,
      updateHandPointer,
      updateSecondaryHand,
      releaseHand,
      triggerPulse(nx = 0.5, ny = 0.5, supernova = false, reverse = false) {
        const intensity = reverse ? -1.25 : supernova ? 1.65 : 1.18;
        addRipple(nx, ny, intensity, { supernova: !reverse && supernova });
      },
      setDirection(direction, active) {
        directions[direction] = active;
      },
      nudge(deltaY) {
        wheelNudge += deltaY;
      },
      touch(deltaY) {
        touching = true;
        touchVelocity = Math.max(-200, Math.min(200, deltaY));
      },
      endTouch() {
        touching = false;
      }
    };
  }

  function attachCanvasControls(player, canvas, config, audio, cameraController) {
    let wakeLock = null;
    let lastTouchY = null;

    canvas.tabIndex = 0;
    canvas.setAttribute("aria-label", "Interactive infinitely zooming painting.");

    canvas.addEventListener("contextmenu", (event) => {
      event.preventDefault();
    });

    canvas.addEventListener("pointermove", (event) => {
      player.onPointerMove(event.clientX, event.clientY);
    });

    canvas.addEventListener("pointerdown", (event) => {
      if (audio) audio.unlock();
      if (cameraController) cameraController.onUserGesture();
      if (event.pointerType === "mouse" && event.button === 2) {
        player.onPointerDown(event.clientX, event.clientY, true);
        return;
      }
      if (event.button !== 0 && event.pointerType === "mouse") return;
      player.onPointerDown(event.clientX, event.clientY, false);
    });

    window.addEventListener("pointerup", () => {
      player.onPointerUp();
    });

    canvas.addEventListener("pointerleave", () => {
      player.onPointerLeave();
    });

    document.addEventListener("keydown", (event) => {
      if (event.code === "Space") {
        event.preventDefault();
        if (!event.repeat) {
          player.setPlaying(!player.getState().playing);
        }
      } else if (event.key === "m" || event.key === "M") {
        if (audio) {
          audio.setEnabled(!audio.isEnabled());
        }
      } else if (event.key === "f" || event.key === "F") {
        toggleFullscreen();
      } else if (event.key === "r" || event.key === "R") {
        if (audio) audio.unlock();
        player.triggerPulse(0.5, 0.5, true);
      } else if (event.key === "c" || event.key === "C") {
        if (cameraController) {
          cameraController.toggle();
        }
      } else if (config.keyboardmovementenabled && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        event.preventDefault();
        player.setDirection(event.key === "ArrowUp" ? "up" : "down", true);
      }
    });

    document.addEventListener("keyup", (event) => {
      if (event.key === "ArrowUp") player.setDirection("up", false);
      if (event.key === "ArrowDown") player.setDirection("down", false);
    });

    window.addEventListener("blur", () => {
      player.setDirection("up", false);
      player.setDirection("down", false);
      player.endTouch();
      player.onPointerLeave();
    });

    if (config.scrollenabled) {
      canvas.addEventListener(
        "wheel",
        (event) => {
          event.preventDefault();
          player.nudge(event.deltaY);
        },
        { passive: false }
      );

      canvas.addEventListener(
        "touchstart",
        (event) => {
          if (audio) audio.unlock();
          if (cameraController) cameraController.onUserGesture();
          if (event.touches.length === 1) {
            const touch = event.touches[0];
            player.onPointerDown(touch.clientX, touch.clientY, false);
            lastTouchY = null;
          } else if (event.touches.length >= 2) {
            lastTouchY = (event.touches[0].clientY + event.touches[1].clientY) / 2;
            const mx = (event.touches[0].clientX + event.touches[1].clientX) / 2;
            player.onPointerDown(mx, lastTouchY, true);
          }
        },
        { passive: true }
      );

      canvas.addEventListener(
        "touchmove",
        (event) => {
          if (event.touches.length === 1) {
            const touch = event.touches[0];
            player.onPointerMove(touch.clientX, touch.clientY);
          } else if (event.touches.length >= 2) {
            const currentY = (event.touches[0].clientY + event.touches[1].clientY) / 2;
            if (lastTouchY !== null) {
              player.touch(currentY - lastTouchY);
            }
            lastTouchY = currentY;
          }
          event.preventDefault();
        },
        { passive: false }
      );

      for (const eventName of ["touchend", "touchcancel"]) {
        canvas.addEventListener(eventName, (event) => {
          lastTouchY = null;
          player.endTouch();
          if (!event.touches || event.touches.length === 0) {
            player.onPointerUp();
          }
        });
      }
    }

    async function toggleFullscreen() {
      try {
        if (document.fullscreenElement || document.webkitFullscreenElement) {
          await (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
        } else {
          await (document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen)?.call(document.documentElement);
        }
      } catch {
      }
    }

    canvas.addEventListener("dblclick", toggleFullscreen);

    async function onFullscreenChange() {
      const isFullscreen = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
      if (isFullscreen) {
        try {
          wakeLock = await navigator.wakeLock?.request("screen");
        } catch {
        }
      } else if (wakeLock) {
        await wakeLock.release().catch(() => {});
        wakeLock = null;
      }
    }

    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("webkitfullscreenchange", onFullscreenChange);
  }

  const zoomConfig = JSON.parse(document.querySelector("#zoom-config").textContent);
  const canvasElement = document.querySelector("#zc");
  const overlayElement = document.querySelector("#fx-overlay");
  try {
    const audio = window.createOrganicAudio ? window.createOrganicAudio() : null;
    const player = createZoomPlayer({ ...zoomConfig, canvas: canvasElement, overlayCanvas: overlayElement, audio });
    const cameraController = window.createCameraGestureController
      ? window.createCameraGestureController({ player, audio })
      : null;
    attachCanvasControls(player, canvasElement, zoomConfig, audio, cameraController);
    if (cameraController) {
      cameraController.start();
    }
    window.zoomPlayer = player;
    window.organicAudio = audio;
    window.cameraController = cameraController;
  } catch (error) {
    document.body.classList.remove("loading");
    console.error(error);
  }
})();
