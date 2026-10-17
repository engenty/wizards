// Shared shader contract for a closed volume, attached surface details and hair.

import { COAT_GOGGLES_GLSL } from "./coat-goggles";
import { MAX_FORM_BLOBS, MAX_FORM_EXTRAS } from "./forms";
import { JELLY_DEFORMATION_GLSL } from "./jelly-deformation";
export const FUR_VIEW = 152;
export const FUR_ORIGIN = -16;
export const FUR_COMMON_GLSL = `#version 300 es
precision highp float;
#define BLOBS ${MAX_FORM_BLOBS}
#define EXTRAS ${MAX_FORM_EXTRAS}
#define VIEW ${FUR_VIEW.toFixed(1)}
#define ORIGIN ${FUR_ORIGIN.toFixed(1)}
#define TAU 6.2831853
uniform vec2 uResolution;
uniform float uTime;
uniform vec4 uBlobs[BLOBS];
uniform float uFalloff;
uniform float uScale;
uniform float uFur;
uniform float uPeriod;
uniform float uInflate;
uniform float uDensity;
uniform float uThick;
uniform vec2 uLean;
uniform vec2 uTurn;
uniform float uGoggles;
uniform vec3 uLight;
uniform vec3 uBody;
uniform vec3 uDeep;
uniform vec3 uTip;
uniform vec3 uEye;
uniform float uWind;
uniform vec2 uGaze;
uniform vec4 uExtras[EXTRAS];
uniform vec4 uExtraMeta[EXTRAS];
uniform vec2 uWobble;
uniform float uClarity;
uniform float uSoftness;
uniform vec4 uPull;
#ifdef JELLY_COAT
${JELLY_DEFORMATION_GLSL}
#endif
vec2 eyeCentre() { return uEye.xy; }
float bodyK(vec2 p) {
  float sum=0.0;
  for(int i=0;i<BLOBS;i++){
    vec4 b=uBlobs[i];if(b.z<=0.0)continue;
    vec2 q=(p-b.xy)/b.zw;sum+=exp(-uFalloff*dot(q,q));
  }
  return sqrt(max(0.0,-log(max(sum,1e-8))/uFalloff));
}
float sdBody(vec2 p){return (bodyK(p)-1.0)*uScale;}
vec3 rotateCoat(vec3 p) {
  vec3 q=vec3(p.x,cos(uTurn.y)*p.y-sin(uTurn.y)*p.z,sin(uTurn.y)*p.y+cos(uTurn.y)*p.z);
  return vec3(cos(uTurn.x)*q.x+sin(uTurn.x)*q.z,q.y,-sin(uTurn.x)*q.x+cos(uTurn.x)*q.z);
}
vec3 bodyStretch(){float s=sin(TAU*uTime/uPeriod)*0.018;return vec3(1.0+s,1.0-s,1.0/(1.0-s*s));}
vec3 poseCoat(vec3 p) {
  float w=TAU*uTime/uPeriod;
#ifdef JELLY_COAT
  p=deformJelly(p);
#endif
  vec3 q=(p-vec3(60.0,60.0,0.0))*bodyStretch();
  q.xy+=uLean*(1.15-p.y/120.0)*0.3;

  q=rotateCoat(q);
  q.xy+=vec2(60.0+sin(w)*1.5,60.0+cos(w*0.8)*1.1);
  return q;
}
vec3 poseNormal(vec3 p,vec3 normal){
#ifdef JELLY_COAT
  vec3 tangent=normalize(cross(normal,abs(normal.y)>0.9?vec3(1.0,0.0,0.0):vec3(0.0,1.0,0.0)));
  vec3 bitangent=cross(normal,tangent);
  vec3 t=poseCoat(p+tangent*0.12)-poseCoat(p-tangent*0.12);
  vec3 b=poseCoat(p+bitangent*0.12)-poseCoat(p-bitangent*0.12);
  return normalize(cross(t,b));
#else
  return rotateCoat(normalize(normal/bodyStretch()));
#endif
}
float coatZoom(){
  float extent=0.0;
  for(int i=0;i<BLOBS;i++){
    vec4 b=uBlobs[i];if(b.z<=0.0)continue;
    extent=max(extent,max(max(abs(b.x-60.0)+b.z,abs(b.y-60.0)+b.w),b.z*uInflate/30.0));
  }
  return min(1.0,65.0/(extent+uFur*1.2+3.0));
}
vec4 projectCoat(vec3 p){
  float zoom=coatZoom();
  vec2 screen=(p.xy-60.0)*zoom+60.0;
  return vec4((screen.x-ORIGIN)/VIEW*2.0-1.0,1.0-(screen.y-ORIGIN)/VIEW*2.0,-p.z*zoom/150.0,1.0);
}
float sdArc(vec2 q,float r,float span){float a=clamp(atan(q.x,-q.y),-span,span);return length(q-vec2(sin(a),-cos(a))*r);}
vec4 extrasOver(vec2 p,vec3 ink,vec3 bodyCol,float aa){
  vec4 acc=vec4(0.0);
  for(int i=0;i<EXTRAS;i++){
    vec4 m=uExtraMeta[i],g=uExtras[i];int kind=int(m.x+0.5);
    if(kind==0||kind==2||(kind==3&&m.w>0.5))continue;
    vec2 q=p-g.xy;float distance=1000.0,hw=m.z*0.5;
    if(kind==1){distance=length(q)-g.z;hw=0.0;}
    else if(kind==3)distance=sdArc(q,g.z,g.w);
    else if(kind==4)distance=length(vec2(q.x,max(abs(q.y)-g.z,0.0)));
    else if(kind==5){float x=clamp(q.x,0.0,g.z);distance=length(q-vec2(x,-g.w*sin(TAU*x/g.z)));}
    float a=(1.0-smoothstep(hw-aa,hw+aa,distance))*m.y;
    vec3 color=mix(ink,bodyCol*0.45,0.2);
    acc=vec4(color*a,a)+acc*(1.0-a);
  }
  return acc;
}
${COAT_GOGGLES_GLSL}
`;
