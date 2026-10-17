import { FUR_COMMON_GLSL } from "./fur-shader";

export const GOOSE_HELMET_VERTEX_SHADER = `${FUR_COMMON_GLSL}
in vec3 aPosition;
in vec3 aNormal;
in vec2 aUv;
in float aMaterial;
// x: form units per stored position step, yzw: the head centre in form space.
uniform vec4 uHelmetFit;
uniform vec3 uHelmetAspect;
// Head units per stored position step.
uniform float uHeadUnit;
out vec3 vNormal;
out vec2 vUv;
out float vHeight;
flat out int vMaterial;

// The rigid helmet follows the head turn, lean and bob. On Jelly it also rides the sway and
// squash of the head under it, as one piece, so the head never slides out from inside it.
vec3 poseHelmet(vec3 p) {
  float w = TAU * uTime / uPeriod;
  vec3 q = p - vec3(60.0, 60.0, 0.0);
#ifdef JELLY_COAT
  float softness = clamp(uSoftness, 0.0, 1.5);
  vec2 lag = clamp(uWobble, vec2(-7.0), vec2(7.0));
  float phase = TAU * uTime / uPeriod;
  float squash = softness * (sin(phase) * 0.08 + sin(phase * 1.7) * 0.012 + lag.y * 0.012);
  // The crown sits about 20 form units above the head centre (uHelmetFit.z).
  float crownY = uHelmetFit.z - 20.0;
  float top = clamp(1.0 - crownY / 125.0, 0.0, 1.0);
  q.x += softness * lag.x * 1.15 * top * top;
  q.y += (crownY - 60.0) * squash;
#endif
  q.xy += uLean * (1.15 - p.y / 120.0) * 0.3;
  q = rotateCoat(q);
  q.xy += vec2(60.0 + sin(w) * 1.5, 60.0 + cos(w * 0.8) * 1.1);
  return q;
}

void main() {
  vec3 p = aPosition * uHelmetFit.x * uHelmetAspect + uHelmetFit.yzw;
  vNormal = rotateCoat(normalize(aNormal / uHelmetAspect));
  vUv = aUv;
  vHeight = aPosition.y * uHeadUnit;
  vMaterial = int(aMaterial + 0.5);
  gl_Position = projectCoat(poseHelmet(p));
}
`;

export const GOOSE_HELMET_FRAGMENT_SHADER = `${FUR_COMMON_GLSL}
in vec3 vNormal;
in vec2 vUv;
in float vHeight;
flat in int vMaterial;
uniform sampler2D uLivery;
out vec4 outColor;

const vec3 ENAMEL = vec3(0.82, 0.05, 0.094);

// Bright overhead softboxes over a warm floor, as in the Blender portrait.
vec3 studio(vec3 r) {
  float up = clamp(-r.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 c = mix(vec3(0.18, 0.16, 0.15), vec3(0.92, 0.9, 0.86), smoothstep(0.4, 0.95, up));
  float key = smoothstep(0.93, 0.99, dot(r, normalize(vec3(-0.6, -0.55, 0.58))));
  float rim = smoothstep(0.95, 0.995, dot(r, normalize(vec3(0.75, -0.35, 0.55))));
  return c + vec3(1.0, 0.98, 0.95) * (key * 1.2 + rim * 0.5);
}

void main() {
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 view = vec3(0.0, 0.0, 1.0);
  vec3 light = normalize(uLight);
  float ndv = max(dot(n, view), 0.0);
  float diffuse = max(dot(n, light), 0.0);
  vec3 r = reflect(-view, n);
  float fresnel = 0.04 + 0.96 * pow(1.0 - ndv, 5.0);
  float spec = pow(max(dot(n, normalize(light + view)), 0.0), 90.0);

  if (vMaterial == 6) {
    // Smoke polycarbonate: darker under the brow, clearer over the eye, with small studio glints.
    float smoke = mix(0.74, 0.26, smoothstep(-0.7, -0.15, vHeight));
    float alpha = smoke + 0.15 * fresnel;
    vec3 tint = vec3(0.015, 0.025, 0.07);
    float glint = smoothstep(0.965, 0.995, dot(r, normalize(vec3(-0.6, -0.55, 0.58))));
    float band = smoothstep(0.75, 0.95, -r.y * 0.5 + 0.5) * 0.12;
    vec3 reflection =
      vec3(1.0, 0.98, 0.95) * (glint * 0.9 + band * 0.6 + fresnel * 0.06) + vec3(1.0) * spec * 0.3;
    outColor = vec4(tint * alpha + reflection, min(1.0, alpha + glint * 0.5));
    return;
  }

  vec3 base;
  float gloss;
  float metal = 0.0;
  if (vMaterial == 1) {
    base = texture(uLivery, vUv).rgb;
    gloss = 0.3;
  } else if (vMaterial == 0) {
    base = ENAMEL;
    gloss = 0.3;
  } else if (vMaterial == 2) {
    base = ENAMEL * 0.7;
    gloss = 0.2;
  } else if (vMaterial == 3) {
    base = vec3(0.62, 0.64, 0.66);
    gloss = 0.5;
    metal = 0.7;
  } else if (vMaterial == 4) {
    base = vec3(0.022, 0.026, 0.036);
    gloss = 0.03;
  } else {
    base = vec3(0.012, 0.018, 0.035);
    gloss = 0.3;
  }
  vec3 color = base * (0.8 + 0.38 * diffuse);
  vec3 env = studio(r);
  color = mix(color, env * mix(vec3(1.0), base, 0.4), metal);
  color += env * gloss * (0.03 + 0.7 * fresnel) * (1.0 - metal * 0.5);
  color += vec3(1.0, 0.97, 0.92) * spec * gloss * 1.6;
  outColor = vec4(color, 1.0);
}
`;
