// crt_composite_pass2.glsl
// Pass 2: Composite original + bloom and apply CRT look
#version 300 es
precision mediump float;

out vec4 fragColor;

uniform sampler2D uTex;      // original image
uniform sampler2D uBloom;    // blurred bright map from pass 1
uniform vec2      uRes;
uniform float     uTime;

#define PI 3.14159265359

// Tunables (can match single-pass)
const float DISTORT_AMT    = 0.12;
const float ABERR_AMT      = 0.0018;
const float SCAN_STRENGTH  = 0.22;
const float SLOT_STRENGTH  = 0.15;
const float VIGNETTE       = 0.85;
const float GRAIN_AMT      = 0.018;
const float BLOOM_MIX      = 1.0; // how much of uBloom to add

float rand(vec2 p){
    p = fract(p * vec2(12.9898,78.233));
    return fract(43758.5453 * (p.x + p.y));
}

vec2 barrel(vec2 uv, float amt){
    vec2 t = uv * 2.0 - 1.0;
    float r2 = dot(t,t);
    t *= 1.0 + amt * r2;
    return clamp(t * 0.5 + 0.5, 0.0, 1.0);
}

vec3 crtMask(vec2 uv, vec2 res){
    float scan = 0.5 + 0.5 * cos((uv.y * res.y) * PI);
    float scanV = mix(1.0, scan, SCAN_STRENGTH);
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
    vec2 uv = gl_FragCoord.xy / uRes;
    uv = barrel(uv, DISTORT_AMT);

    vec2 dir = (uv - 0.5);
    vec2 shift = normalize(dir + 1e-5) * ABERR_AMT;

    float r = texture(uTex, uv + shift).r;
    float g = texture(uTex, uv).g;
    float b = texture(uTex, uv - shift).b;
    vec3 base = vec3(r,g,b);

    vec3 bloom = texture(uBloom, uv).rgb * BLOOM_MIX;

    vec3 color = base + bloom;
    color *= crtMask(uv, uRes);
    color += bloom * vec3(0.4, 0.5, 1.0) * 0.35;
    color *= vignette(uv);

    float grain = rand(uv * uRes + uTime * 24.0) * 2.0 - 1.0;
    color += grain * GRAIN_AMT;

    color = pow(max(color, 0.0), vec3(0.9));
    color = clamp(color, 0.0, 1.0);

    fragColor = vec4(color, 1.0);
}
