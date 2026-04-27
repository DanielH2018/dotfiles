// crt_glow_single.glsl
// Retro CRT + Glow single-pass filter
// Fragment shader (WebGL2 / GLSL 300 ES style)
#version 300 es
precision mediump float;

out vec4 fragColor;

uniform sampler2D uTex;   // source image
uniform vec2      uRes;   // viewport resolution in pixels
uniform float     uTime;  // time in seconds

#define PI 3.14159265359

// Tunables
const float DISTORT_AMT    = 0.12;   // barrel distortion
const float ABERR_AMT      = 0.0018; // chromatic aberration
const float BLOOM_THRESH   = 0.65;   // bright-pass threshold
const float BLOOM_STRENGTH = 0.90;   // strength of glow
const float SCAN_STRENGTH  = 0.22;   // scanline contrast
const float SLOT_STRENGTH  = 0.15;   // RGB triad contrast
const float VIGNETTE       = 0.85;   // vignette radius (lower = darker)
const float GRAIN_AMT      = 0.018;  // film grain amplitude

float rand(vec2 p){ // cheap deterministic noise
    p = fract(p * vec2(12.9898,78.233));
    return fract(43758.5453 * (p.x + p.y));
}

vec2 barrel(vec2 uv, float amt){ // barrel distortion for uv in [0,1]
    vec2 t = uv * 2.0 - 1.0;
    float r2 = dot(t,t);
    t *= 1.0 + amt * r2;
    return clamp(t * 0.5 + 0.5, 0.0, 1.0);
}

// 9-tap blur sampling with thresholded bright-pass
vec3 bloomSample(sampler2D tex, vec2 uv, vec2 texel){
    vec3 c = texture(tex, uv).rgb;
    c = max(c - BLOOM_THRESH, 0.0);
    vec3 acc = c * 0.227027;
    vec2 o1 = texel * 1.384615;
    vec2 o2 = texel * 3.230769;

    acc += (max(texture(tex, uv + vec2( o1.x, 0.0)).rgb - BLOOM_THRESH, 0.0) +
            max(texture(tex, uv + vec2(-o1.x, 0.0)).rgb - BLOOM_THRESH, 0.0) +
            max(texture(tex, uv + vec2(0.0,  o1.y)).rgb - BLOOM_THRESH, 0.0) +
            max(texture(tex, uv + vec2(0.0, -o1.y)).rgb - BLOOM_THRESH, 0.0)) * 0.316216;

    acc += (max(texture(tex, uv + vec2( o2.x, 0.0)).rgb - BLOOM_THRESH, 0.0) +
            max(texture(tex, uv + vec2(-o2.x, 0.0)).rgb - BLOOM_THRESH, 0.0) +
            max(texture(tex, uv + vec2(0.0,  o2.y)).rgb - BLOOM_THRESH, 0.0) +
            max(texture(tex, uv + vec2(0.0, -o2.y)).rgb - BLOOM_THRESH, 0.0)) * 0.070270;

    return acc * BLOOM_STRENGTH;
}

vec3 crtMask(vec2 uv, vec2 res){
    // horizontal scanlines
    float scan = 0.5 + 0.5 * cos((uv.y * res.y) * PI);
    float scanV = mix(1.0, scan, SCAN_STRENGTH);

    // vertical RGB triads
    float triad = fract(uv.x * res.x / 3.0);
    vec3 slot = vec3(
        smoothstep(0.66, 0.00, triad),
        smoothstep(0.33, 0.66, triad),
        smoothstep(1.00, 0.33, triad)
    );
    slot = mix(vec3(1.0), slot, SLOT_STRENGTH);
    return slot * scanV;
}

float vignette(vec2 uv){
    uv = uv * 2.0 - 1.0;
    float d = dot(uv, uv);
    return smoothstep(1.2, VIGNETTE, d);
}

void main(){
    vec2 res = uRes;
    vec2 uv  = gl_FragCoord.xy / res;

    uv = barrel(uv, DISTORT_AMT);

    vec2 texel = 1.0 / res;
    vec2 dir = (uv - 0.5);
    vec2 shift = normalize(dir + 1e-5) * ABERR_AMT;

    float r = texture(uTex, uv + shift).r;
    float g = texture(uTex, uv).g;
    float b = texture(uTex, uv - shift).b;
    vec3 base = vec3(r,g,b);

    vec3 glow = bloomSample(uTex, uv, texel);
    vec3 color = base + glow;

    color *= crtMask(uv, res);
    color += glow * vec3(0.4, 0.5, 1.0) * 0.35;

    color *= vignette(uv);

    float grain = rand(uv * res + uTime * 24.0) * 2.0 - 1.0;
    color += grain * GRAIN_AMT;

    color = pow(max(color, 0.0), vec3(0.9));
    color = clamp(color, 0.0, 1.0);

    fragColor = vec4(color, 1.0);
}
