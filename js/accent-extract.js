// Smart accent extraction from wallpapers / images.
//
// Given an image URL or data URL, samples the image at low resolution
// and returns a vibrant dominant color suitable for use as a UI accent.
// Discards near-black, near-white, and unsaturated colors so we don't
// pick the dark-mode background or white text as the accent.
//
// Usage:
//   const accent = await ArcadeAccentExtract.fromUrl(wallpaperUrl);
//   if (accent) document.documentElement.style.setProperty('--accent', accent);
//
// Returns null if the image fails (CORS taint, network error, no
// vibrant colors found).

(function () {
    const SAMPLE = 64; // downscale to 64x64 before sampling

    function sample(url) {
        return new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                const c = document.createElement('canvas');
                c.width = c.height = SAMPLE;
                const ctx = c.getContext('2d');
                try {
                    ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE);
                    const data = ctx.getImageData(0, 0, SAMPLE, SAMPLE).data;
                    resolve(data);
                } catch {
                    // Tainted canvas (cross-origin without proper headers)
                    resolve(null);
                }
            };
            img.onerror = () => resolve(null);
            img.src = url;
        });
    }

    // RGB → HSL (we score by saturation × lightness-band-fit)
    function rgb2hsl(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const l = (max + min) / 2;
        let h, s;
        if (max === min) { h = s = 0; }
        else {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            switch (max) {
                case r: h = (g - b) / d + (g < b ? 6 : 0); break;
                case g: h = (b - r) / d + 2; break;
                case b: h = (r - g) / d + 4; break;
            }
            h *= 60;
        }
        return [h, s, l];
    }

    function hsl2hex(h, s, l) {
        h /= 360; s = Math.min(1, Math.max(0, s)); l = Math.min(1, Math.max(0, l));
        function f(n) {
            const k = (n + h * 12) % 12;
            const a = s * Math.min(l, 1 - l);
            return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
        }
        const toHex = v => Math.round(v * 255).toString(16).padStart(2, '0');
        return '#' + toHex(f(0)) + toHex(f(8)) + toHex(f(4));
    }

    // Bucket pixels into 24 hue bins, score each by total saturated
    // pixel weight, then pick the best hue and return its average HSL
    // pushed into a vibrant L band.
    function dominant(data) {
        if (!data) return null;
        const bins = new Array(24).fill(null).map(() => ({ count: 0, sumS: 0, sumL: 0 }));
        for (let i = 0; i < data.length; i += 4) {
            const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
            if (a < 200) continue;
            const [h, s, l] = rgb2hsl(r, g, b);
            // Skip near-black, near-white, near-gray
            if (l < 0.15 || l > 0.92) continue;
            if (s < 0.18) continue;
            const bin = Math.floor((h % 360) / 15) % 24;
            bins[bin].count++;
            bins[bin].sumS += s;
            bins[bin].sumL += l;
        }
        // Pick the bin with the highest weighted score (count × avg sat)
        let best = -1, bestScore = 0;
        for (let i = 0; i < 24; i++) {
            const b = bins[i];
            if (!b.count) continue;
            const avgS = b.sumS / b.count;
            const score = b.count * avgS;
            if (score > bestScore) { bestScore = score; best = i; }
        }
        if (best < 0) return null;
        const b = bins[best];
        const avgH = best * 15 + 7.5; // center of bin
        const avgS = Math.max(0.55, Math.min(0.85, b.sumS / b.count + 0.15));
        // Push lightness into the 45-60% band — vibrant but not blinding
        const avgL = Math.max(0.45, Math.min(0.6, b.sumL / b.count));
        return hsl2hex(avgH, avgS, avgL);
    }

    async function fromUrl(url) {
        if (!url) return null;
        const data = await sample(url);
        return dominant(data);
    }

    window.ArcadeAccentExtract = { fromUrl, dominant };
})();
