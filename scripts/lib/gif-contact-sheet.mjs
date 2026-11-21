import {execFileSync} from 'node:child_process';
import ffmpeg from 'ffmpeg-static';

export function writeGifContactSheet(path, panels, width, height, columns = 2) {
    const gutter = 8, rows = Math.ceil(panels.length / columns);
    const sheetWidth = width * columns + gutter * (columns - 1);
    const sheetHeight = height * rows + gutter * (rows - 1);
    const sheet = Buffer.alloc(sheetWidth * sheetHeight * 4, Buffer.from([39, 43, 48, 255]));
    for (const [index, panel] of panels.entries()) {
        const startX = (index % columns) * (width + gutter);
        const startY = Math.floor(index / columns) * (height + gutter);
        for (let y = 0; y < height; y++) {
            sheet.set(panel.subarray(y * width * 4, (y + 1) * width * 4), ((startY + y) * sheetWidth + startX) * 4);
        }
    }
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba',
        '-s', `${sheetWidth}x${sheetHeight}`, '-i', 'pipe:0', '-frames:v', '1', '-threads', '1', '-y', path], {input: sheet});
}
