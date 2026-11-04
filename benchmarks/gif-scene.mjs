// Deterministic renderer shared by throughput and lifecycle benchmarks.
export function draw(ctx, index, width, height, scene = 'opaque') {
    ctx.clearRect(0, 0, width, height);
    if (scene === 'gradient') {
        const gradient = ctx.createLinearGradient(0, 0, width, height);
        gradient.addColorStop(0, `rgba(${40 + index % 100}, 80, 220, 0.15)`);
        gradient.addColorStop(1, `rgba(220, ${80 + index % 100}, 40, 0.85)`);
        ctx.fillStyle = gradient; ctx.fillRect(0, 0, width, height);
        return;
    }
    if (scene !== 'opaque' && scene !== 'mixed') throw new Error('Unknown benchmark scene');
    ctx.fillStyle = '#102030'; ctx.fillRect(0, 0, scene === 'opaque' ? width : width / 3, height);
    for (let bar = 0; bar < 16; bar++) {
        const h = (0.15 + ((index * 7 + bar * 19) % 100) / 150) * height;
        ctx.globalAlpha = scene === 'mixed' && bar % 2 ? 0.5 : 1;
        ctx.fillStyle = ['#44ddaa', '#ffbb44', '#dd5577', '#5599ff'][bar % 4];
        ctx.fillRect(Math.floor(bar * width / 16), Math.floor(height - h), Math.ceil(width / 20), Math.ceil(h));
    }
    ctx.globalAlpha = 1;
}
