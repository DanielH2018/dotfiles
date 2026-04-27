// crt_bloom_pass1.glsl
// Pass 1: Bright-pass + blur -> outputs bloom texture
#version 300 es
precision mediump float;

out vec4 fragColor;

uniform sampler2D uTex;  // source image
uniform vec2      uRes;

const float BLOOM_THRESH   = 0.65;
const float BLOOM_STRENGTH = 1.10; // stronger here; will be mixed later

vec3 bright(vec3 c){
    return max(c - BLOOM_THRESH, 0.0);
}

// 13-tap approximate gaussian (both axes in one pass)
// (Two-pass pipeline total: this pass builds a blurred bright map)
void main(){
    vec2 uv    = gl_FragCoord.xy / uRes;
    vec2 texel = 1.0 / uRes;

    // weights (normalized roughly)
    float w0 = 0.196482; // center
    float w1 = 0.176032;
    float w2 = 0.121621;
    float w3 = 0.064452;
    float w4 = 0.027839;

    vec3 acc = bright(texture(uTex, uv).rgb) * w0;
    for(int i=1;i<=4;i++){
        float fi = float(i);
        vec2 o = texel * fi * 2.0; // a bit wider
        vec3 s1 = bright(texture(uTex, uv + vec2(o.x, 0.0)).rgb);
        vec3 s2 = bright(texture(uTex, uv - vec2(o.x, 0.0)).rgb);
        vec3 s3 = bright(texture(uTex, uv + vec2(0.0, o.y)).rgb);
        vec3 s4 = bright(texture(uTex, uv - vec2(0.0, o.y)).rgb);
        float w = (i==1)? w1 : (i==2)? w2 : (i==3)? w3 : w4;
        acc += (s1 + s2 + s3 + s4) * w * 0.5; // scale down since 4 dirs
    }

    fragColor = vec4(acc * BLOOM_STRENGTH, 1.0);
}
