// Low-frequency elastic waves and shallow dents deform the actual gel surface.
// The same transform attaches the eye to the moving material.
export const JELLY_DEFORMATION_GLSL = `
vec3 deformJelly(vec3 p) {
  vec3 q=p-vec3(60.0,60.0,0.0);
  vec3 local=q/max(uScale,1.0);
  float softness=clamp(uSoftness,0.0,1.5);
  float phase=TAU*uTime/uPeriod;
  vec2 lag=clamp(uWobble,vec2(-7.0),vec2(7.0));
  float squash=softness*(sin(phase)*0.08+sin(phase*1.7)*0.012+lag.y*0.012);
  q.xz*=inversesqrt(1.0+squash);
  q.y*=1.0+squash;
  float top=clamp(1.0-p.y/125.0,0.0,1.0);
  q.x+=softness*(lag.x*1.15*top*top+sin(phase*0.8+local.y*2.5)*0.8);
  float wave=sin(local.x*3.1+uTime*1.15)*sin(local.y*2.7-uTime*0.85)*sin(local.z*2.6+uTime*0.65);
  vec3 d1=local-vec3(-0.42,-0.32,0.72);
  vec3 d2=local-vec3(0.45,0.46,0.7);
  float dents=-3.2*exp(-dot(d1,d1)*8.0)-2.1*exp(-dot(d2,d2)*9.0);
  float face=1.0-0.8*exp(-dot(p.xy-uEye.xy,p.xy-uEye.xy)/(uEye.z*uEye.z*3.0));
  q+=normalize(local+vec3(0.0,0.001,0.0))*softness*face*(wave*3.2+dents);
  vec2 grab=(p.xy-uPull.xy)/max(uScale*0.65,1.0);
  float influence=exp(-dot(grab,grab)*2.0)*smoothstep(-0.2,0.65,local.z);
  q.xy+=uPull.zw*softness*influence;
  q.z-=length(uPull.zw)*softness*influence*0.15;
  return q+vec3(60.0,60.0,0.0);
}
`;
