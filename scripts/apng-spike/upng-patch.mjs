// Experimental build transform only; no production entry imports this module.
export function patchUpng(source) {
    const edits = [
        ['var offset = 8, anim = nimg.frames.length>1, pltAlpha = false;',
            'var offset = 8, anim = nimg.frames.length>0, pltAlpha = false;'],
        ['compressPNG(nimg, 0, true);', 'compressPNG(nimg, 0, false);'],
        ['var CMPR = (data.length>10e6 && window.UZIP!=null) ? window.UZIP : pako;', 'var CMPR = pako;']
    ];
    for (const [before, after] of edits) {
        if (source.split(before).length !== 2) throw new Error('Pinned UPNG patch guard: ' + before);
        source = source.replace(before, after);
    }
    return source;
}
