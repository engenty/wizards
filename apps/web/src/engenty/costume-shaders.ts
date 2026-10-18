import { FUR_COMMON_GLSL } from "./fur-shader";

// Worn parts ride the body's pose; wings flap about their root; the lantern floats on its own.
export const COSTUME_VERTEX_SHADER = `${FUR_COMMON_GLSL}
in vec3 aPosition;
in vec3 aNormal;
in vec3 aOrigin;
in float aMaterial;
in float aMotion;
in vec2 aUv;
out vec3 vNormal;
out vec2 vUv;
flat out int vMaterial;

mat3 turnY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
mat3 turnZ(float a) { float c = cos(a), s = sin(a); return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0); }

void main() {
  vec3 p = aPosition;
  vec3 n = aNormal;
  vMaterial = int(aMaterial + 0.5);
  vUv = aUv;
  if (aMotion > 1.5) {
    float t = TAU * uTime / 3.4;
    mat3 rock = turnZ(sin(t) * 0.1);
    vec3 q = aOrigin + rock * p - vec3(60.0, 60.0, 0.0);
    q.y += sin(t + 1.3) * 2.2;
    q.xy += uLean * 0.15;
    vNormal = rotateCoat(rock * n);
    gl_Position = projectCoat(rotateCoat(q) + vec3(60.0, 60.0, 0.0));
    return;
  }
  if (abs(aMotion) > 0.5) {
    float side = sign(aMotion);
    float beat = sin(TAU * uTime / 1.4);
    mat3 flap = turnY(side * (0.1 + 0.3 * beat)) * turnZ(side * 0.14 * beat);
    p = flap * p;
    n = flap * n;
  }
  vec3 world = aOrigin + p;
  vNormal = poseNormal(world, n);
  gl_Position = projectCoat(poseCoat(world));
}
`;

export const COSTUME_FRAGMENT_SHADER = `${FUR_COMMON_GLSL}
in vec3 vNormal;
in vec2 vUv;
flat in int vMaterial;
out vec4 outColor;

vec3 studio(vec3 r) {
  float up = clamp(-r.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 c = mix(vec3(0.16, 0.14, 0.14), vec3(0.9, 0.88, 0.85), smoothstep(0.4, 0.95, up));
  float key = smoothstep(0.93, 0.99, dot(r, normalize(vec3(-0.6, -0.55, 0.58))));
  return c + vec3(1.0, 0.97, 0.92) * key * 1.1;
}

float segment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}

float triangle(vec2 p, vec2 p0, vec2 p1, vec2 p2) {
  vec2 e0 = p1 - p0, e1 = p2 - p1, e2 = p0 - p2;
  vec2 v0 = p - p0, v1 = p - p1, v2 = p - p2;
  vec2 q0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
  vec2 q1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
  vec2 q2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
  float s = sign(e0.x * e2.y - e0.y * e2.x);
  vec2 d = min(min(vec2(dot(q0, q0), s * (v0.x * e0.y - v0.y * e0.x)),
                   vec2(dot(q1, q1), s * (v1.x * e1.y - v1.y * e1.x))),
                   vec2(dot(q2, q2), s * (v2.x * e2.y - v2.y * e2.x)));
  return -sqrt(d.x) * sign(d.y);
}

// The jack-o'-lantern's carving in (azimuth, elevation) radians, negative inside.
float carving(vec2 f) {
  vec2 m = vec2(abs(f.x), f.y);
  float eye = triangle(m, vec2(0.22, 0.1), vec2(0.62, 0.08), vec2(0.4, 0.44));
  float nose = triangle(f, vec2(-0.08, -0.06), vec2(0.08, -0.06), vec2(0.0, 0.08));
  float x = f.x / 0.74;
  float tooth = 1.0 - smoothstep(0.03, 0.09, abs(m.x - 0.24));
  float top = -0.18 + 0.2 * x * x - 0.1 * tooth;
  float bottom = -0.5 + 0.3 * x * x + 0.1 * (1.0 - smoothstep(0.03, 0.09, abs(f.x)));
  float mouth = max(max(f.y - top, bottom - f.y), abs(f.x) - 0.74);
  return min(min(eye, nose), mouth);
}

void main() {
  vec3 n = normalize(vNormal);
  if (n.z < 0.0) n = -n;
  vec3 view = vec3(0.0, 0.0, 1.0);
  vec3 light = normalize(uLight);
  float ndv = max(dot(n, view), 0.0);
  float diffuse = max(dot(n, light), 0.0);
  vec3 r = reflect(-view, n);
  float fresnel = 0.04 + 0.96 * pow(1.0 - ndv, 5.0);
  float spec = pow(max(dot(n, normalize(light + view)), 0.0), 70.0);
  vec3 base;
  float gloss;
  float metal = 0.0;
  vec3 glow = vec3(0.0);
  if (vMaterial == 0) {
    // Witch's felt: near-black aubergine with a soft purple sheen at grazing angles.
    base = vec3(0.075, 0.05, 0.11);
    gloss = 0.08;
    glow = vec3(0.32, 0.16, 0.5) * pow(1.0 - ndv, 2.5) * 0.5;
  } else if (vMaterial == 1) {
    base = vec3(0.98, 0.45, 0.06);
    gloss = 0.15;
  } else if (vMaterial == 2) {
    base = vec3(0.95, 0.72, 0.28);
    gloss = 0.6;
    metal = 0.85;
  } else if (vMaterial == 3) {
    // Horn: lacquered red, darkening to the tip.
    base = mix(vec3(0.82, 0.07, 0.07), vec3(0.22, 0.01, 0.02), smoothstep(0.25, 1.0, vUv.x));
    gloss = 0.5;
  } else if (vMaterial == 4) {
    vec2 p = vUv;
    float bone = segment(p, vec2(0.0, 0.06), vec2(0.22, 0.34));
    bone = min(bone, segment(p, vec2(0.22, 0.34), vec2(0.5, 0.52)));
    bone = min(bone, segment(p, vec2(0.5, 0.52), vec2(1.0, 0.64)));
    bone = min(bone, segment(p, vec2(0.5, 0.52), vec2(1.06, 0.12)));
    bone = min(bone, segment(p, vec2(0.5, 0.52), vec2(0.84, -0.34)));
    bone = min(bone, segment(p, vec2(0.0, 0.06), vec2(0.3, -0.24)));
    float w = fwidth(bone);
    float ridge = 1.0 - smoothstep(0.018 - w, 0.018 + w, bone);
    base = mix(vec3(0.1, 0.075, 0.13), vec3(0.3, 0.24, 0.36), ridge);
    gloss = 0.12;
  } else if (vMaterial == 5) {
    vec2 f = vUv;
    float groove = 0.5 + 0.5 * cos(8.0 * f.x);
    base = vec3(0.97, 0.43, 0.04) * (1.0 - 0.28 * groove * cos(f.y));
    base = mix(base, vec3(0.62, 0.2, 0.02), smoothstep(1.1, 1.5, abs(f.y)));
    gloss = 0.3;
    float d = abs(f.x) < 1.2 ? carving(f) : 1.0;
    float w = fwidth(d) * 0.8;
    float cut = 1.0 - smoothstep(-w, w, d);
    if (cut > 0.0) {
      float flicker = 0.88 + 0.12 * sin(uTime * 11.0) * sin(uTime * 7.3 + 1.0);
      // The cut wall shows as a thin pale-orange edge before the candlelit inside.
      float wall = smoothstep(-0.06, -0.015, d);
      vec3 candle = mix(vec3(1.0, 0.86, 0.32), vec3(1.0, 0.55, 0.08), smoothstep(-0.25, -0.02, d)) * 1.3 * flicker;
      vec3 inside = mix(candle, vec3(0.98, 0.72, 0.42), wall * 0.7);
      outColor = vec4(mix(base * (0.78 + 0.4 * diffuse), inside, cut), 1.0);
      return;
    }
  } else {
    base = vec3(0.33, 0.37, 0.14);
    gloss = 0.08;
  }
  vec3 color = base * (0.72 + 0.46 * diffuse);
  vec3 env = studio(r);
  color = mix(color, env * mix(vec3(1.0), base, 0.6), metal);
  color += env * gloss * (0.03 + 0.6 * fresnel) * (1.0 - metal * 0.5);
  color += vec3(1.0, 0.97, 0.92) * spec * gloss * 1.4;
  outColor = vec4(color + glow, 1.0);
}
`;
