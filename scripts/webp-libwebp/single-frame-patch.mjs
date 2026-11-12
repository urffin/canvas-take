// Two narrowly scoped, drift-rejecting prototype changes. No bitstream/codec changes.
export function patchSingleFrame(name, source) {
    const replacements = {
        'muxedit.c': ['if (num_frames == 1) {', 'if (num_frames == 1 && !CANVASTAKE_KEEP_ANIMATION) {'],
        'anim_encode.c': ['if (enc->out_frame_count == 1) {', 'if (enc->out_frame_count == 1 && !CANVASTAKE_KEEP_ANIMATION) {']
    };
    const pair = replacements[name];
    if (!pair || source.split(pair[0]).length !== 2 || source.includes('CANVASTAKE_KEEP_ANIMATION')) throw new Error('Single-frame patch drift/reapplication: ' + name);
    return source.replace(pair[0], pair[1]);
}
