import { FUR_COMMON_GLSL } from "./fur-shader";
export const STRAND_VERTEX_SHADER = `${FUR_COMMON_GLSL}
in vec3 aRoot;
in vec3 aNormal;
in vec2 aRandom;
out vec3 vColor;
out float vAcross;
out float vCoverage;
void main(){
  float t=float(gl_VertexID/2)/8.0;
  float side=float(gl_VertexID%2)*2.0-1.0;
  float eyeDistance=length(aRoot.xy-uEye.xy);
  float front=smoothstep(0.0,2.0,aRoot.z);
  float eyeAngle=atan(aRoot.y-uEye.y,aRoot.x-uEye.x);
  float rim=uEye.z*1.35;
  float fringe=sin(eyeAngle*19.0)*0.025+sin(eyeAngle*37.0)*0.015;
  float socket=mix(1.0,smoothstep(rim*(0.88+fringe),rim*(1.08+fringe),eyeDistance),front);
  float underfur=1.0-step(0.36,aRandom.x);
  float len=uFur*mix(0.55+aRandom.x*0.55,0.3+aRandom.x*0.5,underfur)*socket;
  vec3 tangent=normalize(cross(aNormal,abs(aNormal.y)>0.9?vec3(1.0,0.0,0.0):vec3(0.0,1.0,0.0)));
  vec3 flow=aNormal*0.95+tangent*(aRandom.y-0.5)*0.5+vec3(0.04,0.12,0.0);
  float nearEye=front*(1.0-smoothstep(rim, rim*1.5,eyeDistance));
  flow.xy-=normalize(aRoot.xy-uEye.xy+vec2(0.001))*nearEye*0.7;
  float wave=sin(uTime*1.8+aRoot.y*0.09+aRandom.x*TAU);
  vec3 bend=vec3(wave*uWind*0.12,0.07+aRandom.y*0.12,0.0);
  vec3 centre=poseCoat(aRoot+len*(flow*t+bend*t*t));
  vec3 direction=rotateCoat(flow+2.0*bend*t);
  vec2 across=normalize(vec2(-direction.y,direction.x)+vec2(0.00001));
  float radius=uThick*(0.1+aRandom.y*0.09)*mix(1.0,1.8,underfur)*pow(1.0-t,0.8);
  float pixel=VIEW/uResolution.x/coatZoom();
  centre.xy+=across*side*max(radius,pixel*0.7);
  gl_Position=projectCoat(centre);
  vec3 n=normalize(rotateCoat(aNormal/bodyStretch()));
  float lit=max(dot(n,normalize(uLight)),0.0);
  vColor=mix(uDeep,uBody,0.52+t*0.48)*(0.6+lit*0.65);
  vColor+=uTip*pow(1.0-abs(n.z),3.0)*(0.08+t*0.22);
  vColor*=0.82+aRandom.y*0.32;
  vColor+=vec3(0.08)*pow(lit,12.0)*t;
  vAcross=side;
  vCoverage=min(1.0,radius/(pixel*0.7))*socket;
}
`;
export const STRAND_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec3 vColor;
in float vAcross;
in float vCoverage;
out vec4 outColor;
void main(){
  float alpha=(1.0-smoothstep(0.35,1.0,abs(vAcross)))*vCoverage;
  if(alpha<0.025)discard;
  outColor=vec4(vColor*alpha,alpha);
}
`;
