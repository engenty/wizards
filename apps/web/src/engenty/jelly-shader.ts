// Translucent gel on the same closed body as the furry material.
import { FUR_COMMON_GLSL } from "./fur-shader";
import { BODY_FRAGMENT_INPUT } from "./volume-shaders";
export const JELLY_FRAGMENT_SHADER = `${FUR_COMMON_GLSL}${BODY_FRAGMENT_INPUT}
/** Luminance, for turning a reflection into coverage. */
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

/**
 * Coverage of a soft rectangular window seen in direction \`r\`, sitting in
 * the key direction \`w\`. \`soft\` is the blur of the lobe reflecting it.
 */
float windowLobe(vec3 r, vec3 w, float soft, bool panes) {
  float facing = dot(r, w);
  if (facing <= 0.0) { return 0.0; }
  // Tangent frame around the window direction.
  vec3 ax = normalize(cross(w, vec3(0.0, 0.0, 1.0)));
  vec3 ay = cross(w, ax);
  vec2 q = vec2(dot(r, ax), dot(r, ay)) / facing;
  vec2 half_ = vec2(0.26, 0.42);
  vec2 cov = smoothstep(half_ + soft, half_ - soft, abs(q));
  float win = cov.x * cov.y;
  if (panes) {
    // Mullions: two columns, three rows. The grid is what makes a bright
    // patch read as a window and the surface as glass.
    float bar = 0.018;
    float mx = 1.0 - smoothstep(bar, bar + soft, abs(q.x));
    float my = 1.0 - smoothstep(bar, bar + soft, abs(abs(q.y) - 0.14));
    win *= 1.0 - 0.85 * max(mx, my);
  }
  return win;
}

void main(){
  vec2 p=vLocal.xy;
  vec3 n=normalize(vNormal);
  float front=smoothstep(0.0,2.0,vLocal.z);
  float aaPx=max(fwidth(p.x),fwidth(p.y))*0.75;
  vec4 extras=extrasOver(p,uDeep*0.55,uBody,aaPx)*front;
  vec3 light = normalize(uLight);
  vec3 view = vec3(0.0, 0.0, 1.0);
  // 1 at the thick centre, 0 at the rim.
  float ndv = clamp(n.z, 0.0, 1.0);

  // Wavelength-dependent absorption keeps thick gel saturated and its rim clear.
  vec3 skin=mix(uBody,vec3(1.0),0.18);
  vec3 sigma=-log(max(uBody,0.025)/max(skin,0.026));
  float side=clamp(-dot(n.xy,light.xy),-1.0,1.0);
  float chord=ndv*(1.3+0.4*side);
  vec3 gel=skin*exp(-sigma*chord*1.6);
  float wrap=clamp((dot(n,light)+0.6)/1.6,0.0,1.0);
  vec3 col=mix(uDeep*0.5,gel,0.42+wrap*0.58)*(0.75+wrap*0.35);
  // A soft transmitted lobe brightens the side opposite the key light.
  float transmitted=pow(max(dot(n,normalize(vec3(-light.xy,0.45))),0.0),5.0);
  col+=mix(uBody,uTip,0.4)*transmitted*(0.32+0.55*(1.0-ndv));
  vec3 refracted=refract(-view,n,1.0/1.36);
  float focus=pow(max(dot(normalize(vec3(-refracted.xy,ndv)),light),0.0),12.0);
  col+=uBody*focus*0.28;

  // Soft, restrained studio reflections follow the deformed surface normal.
  float f0=0.023;
  float fres=f0+(1.0-f0)*pow(1.0-ndv,5.0);
  vec3 r=reflect(-view,n);
  float windowHdr=5.0;
  vec3 room=mix(vec3(0.075,0.07,0.1),vec3(0.65,0.68,0.73),smoothstep(-0.8,0.8,-r.y));
  float key=windowLobe(r,light,0.11,false);
  float fill=windowLobe(r,normalize(vec3(0.85,0.12,0.35)),0.14,false);
  vec3 coat=vec3(1.0)*key*(0.12+fres*0.24);
  vec3 reflection=room*fres*0.24+coat+vec3(0.65,0.84,1.0)*fill*(0.05+fres*0.12);
  reflection+=uTip*pow(1.0-ndv,7.0)*0.06;
  reflection=1.0-exp(-reflection*1.8);
  col=col*(1.0-fres*0.45)+reflection;
  // Approximate transmission into the host background; the shared canvas does
  // not sample DOM pixels, so this deliberately avoids claiming scene refraction.
  float clarity=mix(0.55,0.24,smoothstep(0.0,0.85,ndv))*uClarity;
  float alpha=min(1.0,1.0-clarity+lum(reflection)*0.65);
  vec4 acc=vec4(min(col,vec3(1.0))*alpha,alpha);

  // ─── eye, in the gel ───────────────────────────────────────────────────────
  float phase = fract(uTime / 5.4);
  float blink = smoothstep(0.955, 0.972, phase) - smoothstep(0.972, 0.99, phase);
  vec2 ep = p - eyeCentre();
  ep.y /= max(1.0 - blink, 0.06);
  float er = uEye.z * 1.35;
  float aa = er * 0.06;
  // A soft dark socket under the lens, as if it sits a little inside the gel.
  acc.rgb *= mix(1.0, mix(0.7, 1.0, smoothstep(er * 0.95, er * 1.4, length(ep))), front);

  float lens = smoothstep(er + aa, er - aa, length(ep)) * front;
  if (lens > 0.0) {
    // ─── glass eye ─────────────────────────────────────────────────────────
    // The lens is a dome set into the gel and the pupil a dark glass bead on
    // it: each has its own hemisphere normal and is shaded like the body —
    // window reflection, Fresnel rim, a little light leaking through the
    // bead's far side — rather than painted flat.
    vec2 el = ep / er;
    float ez = sqrt(max(0.0, 1.0 - dot(el, el)));
    vec3 en = rotateCoat(vec3(el, ez));
    float ndlE = max(dot(en, light), 0.0);
    // Sclera: milky glass, darker where the dome meets the socket.
    vec3 eyeCol = vec3(0.93, 0.94, 0.97) * (0.62 + 0.38 * ndlE) * mix(0.55, 1.0, smoothstep(0.0, 0.5, ez));

    vec2 pupilAt = uGaze * er * 0.45;
    float pr = er * 0.42;
    vec2 pl = (ep - pupilAt) / pr;
    float pz = sqrt(max(0.0, 1.0 - dot(pl, pl)));
    vec3 pn = vec3(pl, pz);
    float pupil = smoothstep(pr + aa, pr - aa, length(ep - pupilAt));
    if (pupil > 0.0) {
      vec3 bead = mix(vec3(0.05, 0.04, 0.10), vec3(0.16, 0.13, 0.24), pow(1.0 - pz, 2.0));
      // The bead is transparent too: light entering at the top leaves at the
      // bottom edge, warmed by the iris.
      float leak = pow(max(dot(pn, normalize(vec3(-light.xy, 0.2))), 0.0), 4.0) * (1.0 - pz);
      bead += mix(uTip, vec3(1.0), 0.4) * leak * 0.55;
      vec3 pr_ = reflect(-view, pn);
      float pf = 0.03 + 0.97 * pow(1.0 - pz, 5.0);
      // A bead this small would show the window as a speck; a flatter
      // reflection normal spreads it to the broad soft patch a glass eye has.
      vec3 prw = reflect(-view, normalize(vec3(pl * 0.4, pz)));
      vec3 pref = (mix(vec3(0.12), vec3(0.6), smoothstep(-0.7, 0.9, -pr_.y)) * pf * 2.0)
        + vec3(1.0) * windowLobe(prw, light, 0.1, true) * windowHdr * (0.05 + pf * 0.5);
      bead += 1.0 - exp(-pref);
      eyeCol = mix(eyeCol, min(bead, vec3(1.0)), pupil);
    }

    // Wet skin over the whole lens.
    vec3 er_ = reflect(-view, en);
    float ef = 0.022 + 0.978 * pow(1.0 - ez, 5.0);
    vec3 lensRef = vec3(0.7, 0.72, 0.8) * ef * 1.6
      + vec3(1.0) * windowLobe(er_, light, 0.06, true) * windowHdr * (0.02 + ef * 0.3);
    eyeCol += 1.0 - exp(-lensRef);

    acc.rgb = acc.rgb * (1.0 - lens) + min(eyeCol, vec3(1.0)) * lens;
    acc.a = acc.a * (1.0 - lens) + lens;
  }

  // Decals sit in the gel: slightly softened by the coat's own alpha, and the
  // wet skin's reflection lies over them.
  float da = extras.a * 0.92;
  acc.rgb = acc.rgb * (1.0 - da) + (extras.rgb + coat * extras.a * 0.5) * 0.92;
  acc.a = acc.a * (1.0 - da) + da;

  outColor = acc;
}
`;
