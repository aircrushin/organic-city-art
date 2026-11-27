(function () {
  "use strict";

  const MODE_INDEX = { awaken: 0, liquid: 1, portal: 2, bloom: 3 };
  const MAX_RIPPLES = 8;
  const MAX_TRAILS = 12;
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
    const maxSpeed = config.maxspeed ?? 36;

    let currentMode = "awaken";
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
      sample: { r: 140, g: 190, b: 255, h: 215, s: 0.85, l: 0.72, edge: 0.4 }
    };

    let panX = 0;
    let panY = 0;
    let targetPanX = 0;
    let targetPanY = 0;
    let lastActiveDrawList = [];

    const ripples = [];
    const trails = [];
    const spores = [];
    const rings = [];
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
        uniform int uMode;
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
          vec2 d = uTexelSize * 1.65;
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
          return clamp(sqrt(gx * gx + gy * gy) * 1.85, 0.0, 1.0);
        }

        void main(void) {
          vec2 resolution = max(uResolution, vec2(1.0));
          float aspect = resolution.x / resolution.y;
          vec2 screenUv = vTextureCoord;
          vec2 uv = screenUv;

          // Pointer-centered living field
          vec2 pDelta = screenUv - uPointer;
          vec2 pAspect = vec2(pDelta.x * aspect, pDelta.y);
          float pDist = length(pAspect);
          vec2 pDir = pDist > 0.0001 ? pAspect / pDist : vec2(0.0, 1.0);
          vec2 pTan = vec2(-pDir.y, pDir.x);
          float pointerField = exp(-pDist * pDist * 24.0) * uPointerActive;
          float wideField = exp(-pDist * pDist * 9.0) * uPointerActive;
          float velMag = clamp(length(uPointerVel) * 28.0, 0.0, 1.8);

          vec2 warp = vec2(0.0);
          float energyGlow = 0.0;
          float chromaShift = 0.0;

          // Mode 0: Awaken (organic breathing + edge bioluminescence)
          // Mode 1: Liquid (fluid silk displacement + glossy ripples)
          // Mode 2: Portal (gravitational time lens + vortex swirl)
          // Mode 3: Bloom (warm glowing botanical aura + gentle shimmer)
          float breathe = sin(uTime * 2.4 - pDist * 18.0);
          if (uMode == 0) {
            warp += vec2(pDir.x / aspect, pDir.y) * (0.006 * breathe * pointerField);
            warp -= uPointerVel * pointerField * 0.45;
            energyGlow += wideField * (0.55 + 0.35 * velMag);
            chromaShift += pointerField * (0.0018 + velMag * 0.0025);
          } else if (uMode == 1) {
            float liquidWave = sin(pDist * 30.0 - uTime * 5.2);
            warp += vec2(pDir.x / aspect, pDir.y) * (0.017 * liquidWave * wideField);
            warp += vec2(pTan.x / aspect, pTan.y) * (0.011 * cos(pDist * 20.0 + uTime * 3.0) * wideField);
            warp -= uPointerVel * wideField * 1.1;
            energyGlow += wideField * (0.55 + 0.5 * velMag);
            chromaShift += wideField * (0.004 + velMag * 0.0045);
          } else if (uMode == 2) {
            float swirlStrength = (0.022 + 0.068 * uHoldAmount) * exp(-pDist * pDist * 11.0) * max(uPointerActive, uHoldAmount);
            warp += vec2(pTan.x / aspect, pTan.y) * swirlStrength;
            warp -= vec2(pDir.x / aspect, pDir.y) * (0.028 * (0.35 + uHoldAmount) * exp(-pDist * pDist * 16.0) * max(uPointerActive, uHoldAmount));
            energyGlow += exp(-pDist * pDist * 10.0) * (0.55 + uHoldAmount * 0.9);
            chromaShift += exp(-pDist * pDist * 12.0) * (0.004 + uHoldAmount * 0.009);
          } else {
            warp += vec2(pDir.x / aspect, pDir.y) * (0.008 * sin(pDist * 22.0 - uTime * 3.5) * wideField);
            energyGlow += exp(-pDist * pDist * 7.5) * uPointerActive * 0.95;
            chromaShift += pointerField * 0.0028;
          }

          // Press-and-hold gravitational lens across all modes
          if (uHoldAmount > 0.001) {
            float holdLens = exp(-pDist * pDist * 14.0) * uHoldAmount;
            warp -= vec2(pDir.x / aspect, pDir.y) * (0.032 * holdLens);
            warp += vec2(pTan.x / aspect, pTan.y) * (0.022 * holdLens * sin(uTime * 1.8 + pDist * 12.0));
            energyGlow += holdLens * 0.85;
            chromaShift += holdLens * 0.006;
          }

          // Zoom-space-locked fluid trails
          for (int i = 0; i < ${MAX_TRAILS}; i++) {
            vec4 tr = uTrails[i];
            if (tr.z > 0.01) {
              vec2 td = screenUv - tr.xy;
              vec2 ta = vec2(td.x * aspect, td.y);
              float dist = length(ta);
              float spread = (uMode == 1) ? 44.0 : 62.0;
              float falloff = exp(-dist * dist * spread) * tr.z;
              vec2 tDir = dist > 0.0001 ? ta / dist : vec2(0.0, 1.0);
              vec2 tTan = vec2(-tDir.y, tDir.x);
              float amp = (uMode == 1 ? 0.016 : 0.0085) * tr.w;
              warp += vec2(tTan.x / aspect, tTan.y) * (falloff * amp * sin(uTime * 4.0 + dist * 26.0));
              warp += vec2(tDir.x / aspect, tDir.y) * (falloff * amp * 0.55);
              energyGlow += falloff * 0.42;
              chromaShift += falloff * 0.0024;
            }
          }

          // Zoom-space-locked resonant click ripples
          float rippleGlow = 0.0;
          for (int i = 0; i < ${MAX_RIPPLES}; i++) {
            vec4 rp = uRipples[i];
            if (rp.w > 0.01) {
              vec2 rd = screenUv - rp.xy;
              vec2 ra = vec2(rd.x * aspect, rd.y);
              float dist = length(ra);
              float waveRadius = rp.z * (uMode == 1 ? 0.58 : 0.46);
              float bandWidth = 0.055 + rp.z * 0.055;
              float ringDelta = dist - waveRadius;
              float envelope = exp(-(ringDelta * ringDelta) / (bandWidth * bandWidth)) * rp.w;
              float wave = sin(ringDelta * 68.0 - uTime * 3.0) * envelope;
              vec2 rDir = dist > 0.0001 ? ra / dist : vec2(0.0, 1.0);
              float pushAmp = (uMode == 1 ? 0.028 : 0.019);
              warp += vec2(rDir.x / aspect, rDir.y) * (wave * pushAmp);
              rippleGlow += envelope;
              chromaShift += envelope * 0.0065;
            }
          }

          uv = clampUv(screenUv + warp);

          // Chromatic prism sampling along distortion direction
          vec2 chromaDir = length(warp) > 0.00005 ? normalize(warp) : vec2(pDir.x / aspect, pDir.y);
          vec3 sceneColor;
          if (chromaShift > 0.0004) {
            sceneColor = vec3(
              sampleScene(uv + chromaDir * chromaShift).r,
              sampleScene(uv).g,
              sampleScene(uv - chromaDir * chromaShift).b
            );
          } else {
            sceneColor = sampleScene(uv);
          }

          // Real-time painted edge detection -> makes brushstrokes, windows & plants light up!
          float edge = detectEdge(uv);
          float activeMask = clamp(energyGlow + rippleGlow * 1.15, 0.0, 1.8);
          vec3 awakenedTint = hueShift(max(sceneColor, vec3(0.18, 0.24, 0.34)), 0.55 + uTime * 0.4 + pDist * 2.2);
          float edgeGlowAmount = edge * activeMask * (uMode == 3 ? 0.78 : 0.56);

          vec3 color = sceneColor;
          // Warm subtle vibrancy lift where user awakens the painting
          float lum = luma(color);
          color = mix(color, mix(vec3(lum), color, 1.24) + vec3(0.03, 0.035, 0.05), clamp(activeMask * 0.42, 0.0, 0.65));
          // Bioluminescent painted edge shimmer
          color += awakenedTint * edgeGlowAmount;
          // Subtle harmonic sheen along expanding ripples
          color += (awakenedTint * 0.65 + vec3(0.22, 0.26, 0.35)) * rippleGlow * (0.14 + 0.32 * edge);

          if (uMode == 2 && uHoldAmount > 0.01) {
            float portalRing = exp(-pow((pDist - 0.14 * (0.6 + 0.4 * uHoldAmount)) / 0.035, 2.0)) * uHoldAmount;
            color = mix(color, hueShift(color, uTime * 0.7 + pDist * 4.0), exp(-pDist * pDist * 18.0) * uHoldAmount * 0.45);
            color += awakenedTint * portalRing * 0.55;
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
        uMode: gl.getUniformLocation(fxProgram, "uMode"),
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

    function spawnSpores(nx, ny, sample, count, burstSpeed) {
      for (let i = 0; i < count; i++) {
        if (spores.length > 220) spores.shift();
        const angle = Math.random() * Math.PI * 2;
        const spd = (0.015 + Math.random() * 0.08) * burstSpeed;
        const hueJitter = (Math.random() - 0.5) * 34;
        spores.push({
          x: nx + (Math.random() - 0.5) * 0.012,
          y: ny + (Math.random() - 0.5) * 0.012,
          vx: Math.cos(angle) * spd,
          vy: Math.sin(angle) * spd,
          size: 1.8 + Math.random() * (currentMode === "bloom" ? 5.2 : 3.4),
          h: (sample.h + hueJitter + 360) % 360,
          s: clamp(sample.s + 0.22, 0.55, 1),
          l: clamp(sample.l + 0.16, 0.55, 0.88),
          life: 1,
          decay: 0.22 + Math.random() * 0.28,
          phase: Math.random() * Math.PI * 2,
          petal: currentMode === "bloom" && Math.random() > 0.35
        });
      }
    }

    function addRipple(nx, ny, intensity = 1) {
      const sample = samplePaintingAtNormalized(nx, ny);
      pointer.sample = sample;
      if (ripples.length >= MAX_RIPPLES) {
        ripples.shift();
      }
      ripples.push({ x: nx, y: ny, age: 0, intensity });

      if (rings.length >= 16) rings.shift();
      rings.push({
        x: nx,
        y: ny,
        radius: 6,
        maxRadius: Math.min(viewportWidth, viewportHeight) * (0.22 + sample.edge * 0.14),
        h: sample.h,
        s: clamp(sample.s + 0.2, 0.55, 1),
        l: clamp(sample.l + 0.2, 0.58, 0.88),
        life: 1
      });

      const sporeCount = currentMode === "bloom" ? 26 : 16;
      spawnSpores(nx, ny, sample, sporeCount, currentMode === "portal" ? 0.55 : 1.15);
      if (audio) {
        audio.triggerResonance(sample, nx, currentMode);
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
      gl.uniform1i(fxLocations.uMode, MODE_INDEX[currentMode] ?? 0);
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
        rp.age += dtSec * 1.1;
        rp.intensity *= Math.pow(0.28, dtSec);
        if (rp.intensity < 0.015 || rp.age > 2.4) {
          ripples.splice(i, 1);
        }
      }

      // Update zoom-space embedded trails
      for (let i = trails.length - 1; i >= 0; i--) {
        const tr = trails[i];
        tr.x = 0.5 + (tr.x - 0.5) * zoomFactor;
        tr.y = 0.5 + (tr.y - 0.5) * zoomFactor;
        tr.life -= dtSec * (currentMode === "liquid" ? 0.85 : 1.15);
        if (tr.life <= 0) {
          trails.splice(i, 1);
        }
      }

      // Expanding color-sampled resonance rings in zoom-space
      for (let i = rings.length - 1; i >= 0; i--) {
        const ring = rings[i];
        ring.x = 0.5 + (ring.x - 0.5) * zoomFactor;
        ring.y = 0.5 + (ring.y - 0.5) * zoomFactor;
        ring.radius = ring.radius * zoomFactor + dtSec * 165;
        ring.life -= dtSec * 0.78;
        if (ring.life <= 0) {
          rings.splice(i, 1);
          continue;
        }
        const rx = ring.x * viewportWidth;
        const ry = ring.y * viewportHeight;
        overlayCtx.beginPath();
        overlayCtx.arc(rx, ry, ring.radius, 0, Math.PI * 2);
        overlayCtx.strokeStyle = hslToRgbaString(ring.h, ring.s, ring.l, ring.life * 0.55);
        overlayCtx.lineWidth = 1.6 * ring.life;
        overlayCtx.stroke();

        overlayCtx.beginPath();
        overlayCtx.arc(rx, ry, ring.radius * 0.72, 0, Math.PI * 2);
        overlayCtx.strokeStyle = hslToRgbaString((ring.h + 38) % 360, ring.s, ring.l, ring.life * 0.25);
        overlayCtx.lineWidth = 1;
        overlayCtx.stroke();
      }

      // Living spores / fireflies / petals embedded inside the zooming architecture
      for (let i = spores.length - 1; i >= 0; i--) {
        const sp = spores[i];
        sp.x = 0.5 + (sp.x - 0.5) * zoomFactor;
        sp.y = 0.5 + (sp.y - 0.5) * zoomFactor;

        if (pointer.hold > 0.05 && currentMode === "portal") {
          const dx = pointer.x - sp.x;
          const dy = pointer.y - sp.y;
          const dist = Math.hypot(dx, dy) + 0.02;
          sp.vx += ((dx / dist) * 0.14 - (dy / dist) * 0.2) * pointer.hold * dtSec;
          sp.vy += ((dy / dist) * 0.14 + (dx / dist) * 0.2) * pointer.hold * dtSec;
        } else if (pointer.active > 0.1) {
          const dx = sp.x - pointer.x;
          const dy = sp.y - pointer.y;
          const dist = Math.hypot(dx, dy);
          if (dist < 0.16 && dist > 0.001) {
            const push = (0.16 - dist) * 0.35 * dtSec;
            sp.vx += (dx / dist) * push + pointer.vx * 0.25;
            sp.vy += (dy / dist) * push + pointer.vy * 0.25;
          }
        }

        sp.x += sp.vx * dtSec + Math.sin(elapsedTime * 2.1 + sp.phase) * 0.004 * dtSec;
        sp.y += sp.vy * dtSec + Math.cos(elapsedTime * 1.8 + sp.phase) * 0.004 * dtSec;
        sp.vx *= Math.pow(0.22, dtSec);
        sp.vy *= Math.pow(0.22, dtSec);
        sp.size = clamp(sp.size * Math.pow(zoomFactor, 0.45), 1, 14);
        sp.life -= sp.decay * dtSec;

        if (sp.life <= 0 || sp.x < -0.15 || sp.x > 1.15 || sp.y < -0.15 || sp.y > 1.15) {
          spores.splice(i, 1);
          continue;
        }

        const sx = sp.x * viewportWidth;
        const sy = sp.y * viewportHeight;
        const alpha = Math.sin(Math.min(1, sp.life) * Math.PI) * 0.85;

        const glow = overlayCtx.createRadialGradient(sx, sy, 0, sx, sy, sp.size * 3.4);
        glow.addColorStop(0, hslToRgbaString(sp.h, sp.s, Math.min(0.95, sp.l + 0.12), alpha));
        glow.addColorStop(0.45, hslToRgbaString(sp.h, sp.s, sp.l, alpha * 0.4));
        glow.addColorStop(1, hslToRgbaString(sp.h, sp.s, sp.l, 0));
        overlayCtx.fillStyle = glow;
        overlayCtx.beginPath();
        overlayCtx.arc(sx, sy, sp.size * 3.4, 0, Math.PI * 2);
        overlayCtx.fill();

        if (sp.petal) {
          overlayCtx.save();
          overlayCtx.translate(sx, sy);
          overlayCtx.rotate(elapsedTime * 1.6 + sp.phase);
          overlayCtx.fillStyle = hslToRgbaString(sp.h, sp.s, 0.9, alpha * 0.9);
          overlayCtx.beginPath();
          overlayCtx.ellipse(0, 0, sp.size * 1.3, sp.size * 0.55, 0, 0, Math.PI * 2);
          overlayCtx.fill();
          overlayCtx.restore();
        }
      }

      // Delicate living filaments connecting awakened spores near the cursor
      if (pointer.active > 0.08 && spores.length > 0) {
        const maxLinkDist = currentMode === "bloom" ? 155 : 125;
        overlayCtx.lineWidth = 0.85;
        for (let i = 0; i < spores.length; i++) {
          const sp = spores[i];
          const sx = sp.x * viewportWidth;
          const sy = sp.y * viewportHeight;
          const dist = Math.hypot(sx - px, sy - py);
          if (dist < maxLinkDist) {
            const strength = (1 - dist / maxLinkDist) * pointer.active * sp.life * 0.42;
            overlayCtx.strokeStyle = hslToRgbaString(sp.h, sp.s, 0.82, strength);
            overlayCtx.beginPath();
            overlayCtx.moveTo(px, py);
            overlayCtx.lineTo(sx, sy);
            overlayCtx.stroke();
          }
        }
      }

      // Organic living aura tinted live by the painting pixel under the pointer
      if (pointer.active > 0.02) {
        const sample = pointer.sample;
        const auraRadius = (currentMode === "portal" ? 62 : 44) + pointer.hold * 42 + sample.edge * 22;
        const grad = overlayCtx.createRadialGradient(px, py, 2, px, py, auraRadius);
        grad.addColorStop(0, hslToRgbaString(sample.h, clamp(sample.s + 0.2, 0.5, 1), 0.86, 0.24 * pointer.active));
        grad.addColorStop(0.5, hslToRgbaString((sample.h + 24) % 360, 0.8, 0.65, 0.09 * pointer.active));
        grad.addColorStop(1, "rgba(255, 255, 255, 0)");
        overlayCtx.fillStyle = grad;
        overlayCtx.beginPath();
        overlayCtx.arc(px, py, auraRadius, 0, Math.PI * 2);
        overlayCtx.fill();

        // Fine center ring showing resonance color
        overlayCtx.beginPath();
        overlayCtx.arc(px, py, 7 + pointer.hold * 16 + Math.sin(elapsedTime * 5) * 1.5, 0, Math.PI * 2);
        overlayCtx.strokeStyle = hslToRgbaString(sample.h, clamp(sample.s + 0.25, 0.55, 1), 0.88, 0.45 * pointer.active);
        overlayCtx.lineWidth = 1.2;
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

      // Gentle organic parallax steering as pointer explores the painting
      if (pointer.isInside) {
        const parallaxStrength = pointer.isDown ? 0.075 : 0.028;
        targetPanX = (0.5 - pointer.x) * baseWidth * parallaxStrength;
        targetPanY = (0.5 - pointer.y) * baseHeight * parallaxStrength;
      } else {
        targetPanX = 0;
        targetPanY = 0;
      }
      const panEase = 1 - Math.exp(-dtSec * 4.5);
      panX += (targetPanX - panX) * panEase;
      panY += (targetPanY - panY) * panEase;

      // Holding gently slows zoom time so you can inspect & sculpt any detail
      const timeDilation = 1 - pointer.hold * 0.72;

      let deltaPosition = 0;
      const stepUnit = 3e-4 * deltaMs;
      if (wheelNudge !== 0) {
        deltaPosition += wheelNudge / 1500;
        wheelNudge = 0;
      }
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

      // Ambient spores while holding or in Bloom mode
      if (pointer.isInside && (pointer.hold > 0.2 || currentMode === "bloom") && Math.random() < (pointer.hold > 0.2 ? 0.45 : 0.18)) {
        const sample = samplePaintingAtNormalized(pointer.x, pointer.y);
        pointer.sample = sample;
        spawnSpores(pointer.x, pointer.y, sample, 1, 0.55);
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

    function setMode(nextMode) {
      if (MODE_INDEX[nextMode] === undefined) return;
      currentMode = nextMode;
      bodyElement.dataset.mode = nextMode;
    }

    let lastMoveSampleAt = 0;
    function onPointerMove(clientX, clientY) {
      const nx = clamp(clientX / Math.max(viewportWidth, 1), 0, 1);
      const ny = clamp(clientY / Math.max(viewportHeight, 1), 0, 1);
      const moveDist = Math.hypot(nx - pointer.targetX, ny - pointer.targetY);
      pointer.targetX = nx;
      pointer.targetY = ny;
      pointer.isInside = true;

      const now = performance.now();
      if (moveDist > 0.008) {
        addTrailPoint(nx, ny, moveDist * 18);
      }
      if (now - lastMoveSampleAt > 55) {
        lastMoveSampleAt = now;
        const sample = samplePaintingAtNormalized(nx, ny);
        pointer.sample = sample;

        if (moveDist > 0.012 && (sample.edge > 0.22 || currentMode === "bloom" || pointer.isDown)) {
          spawnSpores(nx, ny, sample, currentMode === "bloom" ? 3 : 1, 0.45 + moveDist * 10);
        }
        if (audio && moveDist > 0.018 && sample.edge > 0.24) {
          audio.triggerGlideSpark(sample, nx, clamp(moveDist * 22, 0.2, 1.5));
        }
      }
    }

    function onPointerDown(clientX, clientY) {
      const nx = clamp(clientX / Math.max(viewportWidth, 1), 0, 1);
      const ny = clamp(clientY / Math.max(viewportHeight, 1), 0, 1);
      pointer.targetX = nx;
      pointer.targetY = ny;
      pointer.isInside = true;
      pointer.isDown = true;
      addRipple(nx, ny, 1.1);
    }

    function onPointerUp() {
      pointer.isDown = false;
    }

    function onPointerLeave() {
      pointer.isInside = false;
      pointer.isDown = false;
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
        mode: currentMode,
        renderer,
        activeRipples: ripples.length,
        activeSpores: spores.length
      }),
      setSpeed(nextSpeed) {
        speed = Math.max(-maxSpeed, Math.min(maxSpeed, Number(nextSpeed)));
      },
      setPlaying(nextPlaying) {
        playing = Boolean(nextPlaying);
      },
      setMode,
      onPointerMove,
      onPointerDown,
      onPointerUp,
      onPointerLeave,
      triggerPulse(nx, ny) {
        addRipple(nx, ny, 1.15);
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

  function attachCanvasControls(player, canvas, config, audio) {
    const bodyElement = document.body;
    const hudElement = document.getElementById("art-hud");
    const hintElement = document.getElementById("art-hint");
    const playButton = document.getElementById("btn-play");
    const speedSlider = document.getElementById("speed-slider");
    const audioButton = document.getElementById("btn-audio");
    const fullscreenButton = document.getElementById("btn-fullscreen");
    const modeButtons = Array.from(document.querySelectorAll(".mode-btn[data-mode]"));

    let cursorTimer;
    let hudIdleTimer;
    let wakeLock = null;
    let lastTouchY = null;
    let hintDismissed = false;

    canvas.tabIndex = 0;
    canvas.setAttribute("aria-label", "Interactive infinitely zooming painting.");

    function dismissHint() {
      if (hintDismissed || !hintElement) return;
      hintDismissed = true;
      hintElement.classList.add("is-hidden");
    }

    window.setTimeout(dismissHint, 7500);

    function syncHud() {
      const state = player.getState();
      if (playButton) {
        playButton.classList.toggle("is-paused", !state.playing);
        playButton.setAttribute("aria-pressed", String(!state.playing));
      }
      if (speedSlider && document.activeElement !== speedSlider) {
        speedSlider.value = String(state.speed);
      }
      for (const button of modeButtons) {
        const active = button.dataset.mode === state.mode;
        button.classList.toggle("is-active", active);
        button.setAttribute("aria-pressed", String(active));
      }
      if (audioButton && audio) {
        const enabled = audio.isEnabled();
        audioButton.classList.toggle("is-muted", !enabled);
        audioButton.setAttribute("aria-pressed", String(enabled));
      }
    }

    function isInteractiveTarget(target) {
      return target && target.closest
        ? target.closest('input, button, a, textarea, select, [role="button"], [role="slider"], [contenteditable]')
        : null;
    }

    for (const button of modeButtons) {
      button.addEventListener("click", () => {
        player.setMode(button.dataset.mode);
        dismissHint();
        syncHud();
      });
    }

    if (playButton) {
      playButton.addEventListener("click", () => {
        player.setPlaying(!player.getState().playing);
        syncHud();
      });
    }

    if (speedSlider) {
      speedSlider.addEventListener("input", () => {
        player.setSpeed(Number(speedSlider.value));
        player.setPlaying(true);
        syncHud();
      });
    }

    if (audioButton && audio) {
      audioButton.addEventListener("click", () => {
        audio.setEnabled(!audio.isEnabled());
        syncHud();
      });
    }

    // Canvas pointer interaction (hover awakening, click resonance, hold lens/drag)
    canvas.addEventListener("pointermove", (event) => {
      player.onPointerMove(event.clientX, event.clientY);
    });

    canvas.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 && event.pointerType === "mouse") return;
      dismissHint();
      if (audio) audio.unlock();
      player.onPointerDown(event.clientX, event.clientY);
    });

    window.addEventListener("pointerup", () => {
      player.onPointerUp();
    });

    canvas.addEventListener("pointerleave", () => {
      player.onPointerLeave();
    });

    document.addEventListener("keydown", (event) => {
      if (isInteractiveTarget(event.target)) return;
      if (event.code === "Space") {
        event.preventDefault();
        if (!event.repeat) {
          player.setPlaying(!player.getState().playing);
          syncHud();
        }
      } else if (event.key === "1") {
        player.setMode("awaken");
        syncHud();
      } else if (event.key === "2") {
        player.setMode("liquid");
        syncHud();
      } else if (event.key === "3") {
        player.setMode("portal");
        syncHud();
      } else if (event.key === "4") {
        player.setMode("bloom");
        syncHud();
      } else if (event.key === "m" || event.key === "M") {
        if (audio) {
          audio.setEnabled(!audio.isEnabled());
          syncHud();
        }
      } else if (event.key === "f" || event.key === "F") {
        toggleFullscreen();
      } else if (event.key === "h" || event.key === "H") {
        bodyElement.classList.toggle("hud-hidden");
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
          dismissHint();
          if (audio) audio.unlock();
          if (event.touches.length === 1) {
            const touch = event.touches[0];
            player.onPointerDown(touch.clientX, touch.clientY);
            lastTouchY = null;
          } else if (event.touches.length >= 2) {
            lastTouchY = (event.touches[0].clientY + event.touches[1].clientY) / 2;
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
    if (fullscreenButton) {
      fullscreenButton.addEventListener("click", toggleFullscreen);
    }

    async function onFullscreenChange() {
      const isFullscreen = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
      if (fullscreenButton) {
        fullscreenButton.setAttribute("aria-pressed", String(isFullscreen));
      }
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

    function resetCursorHideTimer() {
      clearTimeout(cursorTimer);
      clearTimeout(hudIdleTimer);
      bodyElement.classList.remove("cursorhidden");
      bodyElement.classList.remove("hud-idle");
      cursorTimer = setTimeout(() => {
        if (hudElement && hudElement.matches(":hover")) return;
        bodyElement.classList.add("cursorhidden");
      }, 1800);
      hudIdleTimer = setTimeout(() => {
        if (hudElement && hudElement.matches(":hover")) return;
        bodyElement.classList.add("hud-idle");
      }, 2600);
    }

    document.addEventListener("pointermove", resetCursorHideTimer, { passive: true });
    document.addEventListener("keydown", resetCursorHideTimer);
    syncHud();
    resetCursorHideTimer();
  }

  const zoomConfig = JSON.parse(document.querySelector("#zoom-config").textContent);
  const canvasElement = document.querySelector("#zc");
  const overlayElement = document.querySelector("#fx-overlay");
  try {
    const audio = window.createOrganicAudio ? window.createOrganicAudio() : null;
    const player = createZoomPlayer({ ...zoomConfig, canvas: canvasElement, overlayCanvas: overlayElement, audio });
    attachCanvasControls(player, canvasElement, zoomConfig, audio);
    window.zoomPlayer = player;
    window.organicAudio = audio;
  } catch (error) {
    document.body.classList.remove("loading");
    console.error(error);
  }
})();
