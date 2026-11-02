export function makeOfflinePcm(rate, channels, samples) {
    const markers=[3,21,39,63].map(frame=>Math.round(frame*rate/30));
    return Array.from({length:channels},(_,c)=>{
        const data=new Float32Array(samples);let seed=0x12345678+c*101,filtered=0;
        for(let i=0;i<samples;i++){
            seed=(Math.imul(seed,1664525)+1013904223)>>>0;filtered=filtered*0.86+(seed/0x80000000-1)*0.14;
            data[i]=filtered*0.55+(markers.some(start=>i>=start&&i<start+Math.round(rate*0.04))?0.6*Math.sin(i*2*Math.PI*(c?1703:2003)/rate):0);
        }return data;
    });
}
