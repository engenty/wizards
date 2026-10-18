import { FUR_COMMON_GLSL } from "./fur-shader";
export const BODY_VERTEX_SHADER = `${FUR_COMMON_GLSL}
in vec3 aPosition;
in vec3 aNormal;
out vec3 vLocal;
out vec3 vNormal;
void main(){
  vLocal=aPosition;
  vNormal=poseNormal(aPosition,aNormal);
  gl_Position=projectCoat(poseCoat(aPosition));
}
`;
export const BODY_FRAGMENT_INPUT = `
in vec3 vLocal;
in vec3 vNormal;
out vec4 outColor;
`;
export const FUR_BODY_SHADER = `${FUR_COMMON_GLSL}${BODY_FRAGMENT_INPUT}
void main(){
  vec2 p=vLocal.xy;
  vec3 n=normalize(vNormal),light=normalize(uLight);
  float aa=max(fwidth(p.x),fwidth(p.y))*0.7;
  float lit=max(dot(n,light),0.0);
  vec3 color=mix(uDeep,uBody,0.48)*(0.65+0.5*lit);
  float front=smoothstep(0.0,2.0,vLocal.z);
  vec2 ep=p-uEye.xy;
  float er=uEye.z*1.35;
  color*=mix(0.7,1.0,smoothstep(er*0.9,er*1.35,length(ep))*front+(1.0-front));
  float phase=fract(uTime/5.4);
  float blink=smoothstep(0.955,0.972,phase)-smoothstep(0.972,0.99,phase);
  ep.y/=max(1.0-blink,0.035);
  float lens=(1.0-smoothstep(er-aa,er+aa,length(ep)))*front;
  vec3 eyeNormal=rotateCoat(vec3(ep/er,sqrt(max(0.0,1.0-dot(ep,ep)/(er*er)))));
  vec3 eyeColor=mix(vec3(0.78,0.83,0.92),vec3(1.0),0.5+max(dot(eyeNormal,light),0.0)*0.5);
  vec2 pupil=ep-uGaze/max(1.0,length(uGaze))*er*0.42;
  float iris=1.0-smoothstep(er*0.43-aa,er*0.43+aa,length(pupil));
  eyeColor=mix(eyeColor,vec3(0.075,0.06,0.13),iris);
  float glint=1.0-smoothstep(er*0.1,er*0.16,length(pupil+vec2(er*0.14,er*0.17)));
  eyeColor=mix(eyeColor,vec3(1.0),glint*iris);
  // Directional contact shade from the irregular fur fringe, strongest above.
  float angle=atan(ep.y,ep.x);
  float edge=length(ep)/er+sin(angle*19.0)*0.025+sin(angle*37.0)*0.015;
  float contact=smoothstep(0.72,1.02,edge)*(0.25+0.3*clamp(-ep.y/er,0.0,1.0));
  eyeColor*=1.0-contact;
  color=mix(color,eyeColor,lens);
  vec4 extras=extrasOver(p,uDeep*0.55,uBody,aa)*front*(1.0-lens);
  color=color*(1.0-extras.a)+extras.rgb;
  outColor=vec4(color,1.0);
}
`;
