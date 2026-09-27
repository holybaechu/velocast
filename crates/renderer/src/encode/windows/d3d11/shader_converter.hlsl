// Input SRV is UNORM, not sRGB: the browser's encoded RGB values must not be linearized.
Texture2D<float4> input_rgb : register(t0);
float4 vs_main(uint id : SV_VertexID) : SV_Position {
    float2 p = float2((id << 1) & 2, id & 2);
    return float4(p * float2(2.0, -2.0) + float2(-1.0, 1.0), 0.0, 1.0);
}
float quantize(float value) { return floor(value + 0.5) / 255.0; }
float ps_luma(float4 position : SV_Position) : SV_Target {
    float3 rgb = input_rgb.Load(int3(int2(position.xy), 0)).rgb;
    return quantize(16.0 + 219.0 * dot(rgb, float3(0.2126, 0.7152, 0.0722)));
}
float2 ps_chroma(float4 position : SV_Position) : SV_Target {
    int2 p = int2(position.xy) * 2;
    float3 rgb = (input_rgb.Load(int3(p, 0)).rgb
        + input_rgb.Load(int3(p + int2(1, 0), 0)).rgb
        + input_rgb.Load(int3(p + int2(0, 1), 0)).rgb
        + input_rgb.Load(int3(p + int2(1, 1), 0)).rgb) * 0.25;
    float y = dot(rgb, float3(0.2126, 0.7152, 0.0722));
    return float2(quantize(128.0 + 224.0 * (rgb.b - y) / 1.8556),
                  quantize(128.0 + 224.0 * (rgb.r - y) / 1.5748));
}

// Full-range BT.601 candidate: same centered box footprint and quantizer.
float ps_luma_601_full(float4 position : SV_Position) : SV_Target {
    float3 rgb = input_rgb.Load(int3(int2(position.xy), 0)).rgb;
    return quantize(255.0 * dot(rgb, float3(0.299, 0.587, 0.114)));
}
float2 ps_chroma_601_full(float4 position : SV_Position) : SV_Target {
    int2 p = int2(position.xy) * 2;
    float3 rgb = (input_rgb.Load(int3(p, 0)).rgb
        + input_rgb.Load(int3(p + int2(1, 0), 0)).rgb
        + input_rgb.Load(int3(p + int2(0, 1), 0)).rgb
        + input_rgb.Load(int3(p + int2(1, 1), 0)).rgb) * 0.25;
    float y = dot(rgb, float3(0.299, 0.587, 0.114));
    return float2(quantize(clamp(128.0 + 255.0 * (rgb.b - y) / 1.772, 0.0, 255.0)),
                  quantize(clamp(128.0 + 255.0 * (rgb.r - y) / 1.402, 0.0, 255.0)));
}
