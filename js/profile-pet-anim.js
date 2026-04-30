// Profile pet — sprite-based wandering animals.
//
// Replaces the previous emoji-based pet. Cat uses the well-known
// oneko.js sprite (32×32 spritesheet, public-domain pixel art from
// the X11 era — the same one as adryd325/oneko.js). It actually walks
// in 2D toward random targets in the profile modal, plays idle/sleep
// animations when stopped, and faces the right direction.
//
// For pets we don't have a sprite for yet (slime/duck/dragon/ghost)
// we still render an emoji, but at least have it wander randomly in
// 2D with real idle states (bobbing, floating, breathing) so it
// doesn't look like a stuck character.
//
// Sprite reference — the oneko spritesheet has 8 columns × 4 rows of
// 32px frames. Frame coordinates below are in 32px units (multiplied
// by 32 to get pixel offsets in background-position).

(function () {
    const ONEKO_URL = 'https://cdn.jsdelivr.net/gh/adryd325/oneko.js@14bab15a755d0e35cd4ae19c931d96d306f99f42/oneko.gif';

    // Cat sprite frames (from oneko.js source).
    // Idle: single frame. Animations: arrays cycle each tick.
    const CAT_FRAMES = {
        idle:        [[-3, -3]],
        alert:       [[-7, -3]],
        scratchSelf: [[-5,  0], [-6,  1], [-7,  0]],
        tired:       [[-3, -2]],
        sleeping:    [[-2,  0], [-2, -1]],
        N:           [[-1, -2], [-1, -3]],
        NE:          [[ 0, -2], [ 0, -3]],
        E:           [[-3,  0], [-3, -1]],
        SE:          [[-5, -1], [-5, -2]],
        S:           [[-6, -3], [-7, -2]],
        SW:          [[-5, -3], [-6, -1]],
        W:           [[-4, -2], [-4, -3]],
        NW:          [[-1,  0], [-1, -1]],
    };

    // Pet definitions. Each pet is either a sprite-based one (using a
    // sprite sheet + frame map) or an emoji fallback with motion class.
    const PET_DEFS = {
        cat: {
            kind: 'sprite',
            url: ONEKO_URL,
            frameSize: 32,
            frames: CAT_FRAMES,
            speed: 50, // pixels per second
        },
        // Dog: same sprite sheet flipped + tinted for variety. Until
        // we ship a dedicated dog sprite, this is a stand-in that
        // visually reads as a different animal.
        dog: {
            kind: 'sprite',
            url: ONEKO_URL,
            frameSize: 32,
            frames: CAT_FRAMES,
            tint: 'sepia(1) saturate(2.5) hue-rotate(-30deg)', // brown-ish
            speed: 60,
        },
        // Emoji-based fallbacks for animals we don't have sprites for.
        // Each has a bespoke idle animation so it doesn't look static.
        slime:  { kind: 'emoji', char: '🟢', size: 30, speed: 35, idle: 'bounce' },
        duck:   { kind: 'emoji', char: '🦆', size: 28, speed: 50, idle: 'waddle' },
        dragon: { kind: 'emoji', char: '🐲', size: 34, speed: 45, idle: 'hover' },
        ghost:  { kind: 'emoji', char: '👻', size: 30, speed: 45, idle: 'float' },
    };

    // ─── Pet runtime ─────────────────────────────────────────────
    // One Pet instance per mounted modal. Holds its own RAF + state
    // so destroy() cleanly cancels everything on profile close.
    class Pet {
        constructor(container, def) {
            this.container = container;
            this.def = def;
            this.x = 50; this.y = 50;
            this.targetX = 50; this.targetY = 50;
            this.lastTick = performance.now();
            this.animTick = 0;
            this.idleSince = 0;
            this.state = 'idle';
            this.rafId = null;
            this.lastRetarget = 0;
            this.makeElement();
            this.pickTarget();
            this.loop = this.loop.bind(this);
            this.rafId = requestAnimationFrame(this.loop);
        }

        makeElement() {
            const el = document.createElement('div');
            el.className = `profile-pet profile-pet-${this.def.kind}`;
            el.setAttribute('aria-hidden', 'true');
            if (this.def.kind === 'sprite') {
                el.style.width = this.def.frameSize + 'px';
                el.style.height = this.def.frameSize + 'px';
                el.style.backgroundImage = `url(${this.def.url})`;
                el.style.backgroundRepeat = 'no-repeat';
                el.style.imageRendering = 'pixelated';
                if (this.def.tint) el.style.filter = this.def.tint;
            } else {
                el.style.fontSize = this.def.size + 'px';
                el.textContent = this.def.char;
                if (this.def.idle) el.classList.add(`profile-pet-idle-${this.def.idle}`);
            }
            this.container.appendChild(el);
            this.el = el;
        }

        // Pick a random spot in the modal to walk to.
        pickTarget() {
            const rect = this.container.getBoundingClientRect();
            const margin = 40;
            // Stay inside reasonable bounds (top half is wallpaper +
            // identity; we keep the pet in the lower 60% so it doesn't
            // walk on text).
            const maxX = Math.max(margin + 50, rect.width - margin);
            const minY = Math.min(rect.height * 0.55, rect.height - 100);
            const maxY = Math.max(minY + 50, rect.height - margin);
            this.targetX = margin + Math.random() * (maxX - margin);
            this.targetY = minY + Math.random() * (maxY - minY);
            this.lastRetarget = performance.now();
        }

        // 2D direction → cat sprite frame key. 8 compass headings.
        compass(dx, dy) {
            const ang = Math.atan2(dy, dx) * 180 / Math.PI;
            // ang ranges -180..180. 0 = east. We want N/NE/E/SE/S/SW/W/NW.
            if (ang >= -22.5  && ang <  22.5)  return 'E';
            if (ang >=  22.5  && ang <  67.5)  return 'SE';
            if (ang >=  67.5  && ang < 112.5)  return 'S';
            if (ang >= 112.5  && ang < 157.5)  return 'SW';
            if (ang >= 157.5  || ang < -157.5) return 'W';
            if (ang >= -157.5 && ang < -112.5) return 'NW';
            if (ang >= -112.5 && ang < -67.5)  return 'N';
            if (ang >= -67.5  && ang < -22.5)  return 'NE';
            return 'S';
        }

        loop(now) {
            const dt = Math.min(0.1, (now - this.lastTick) / 1000); // clamp big gaps
            this.lastTick = now;

            const dx = this.targetX - this.x;
            const dy = this.targetY - this.y;
            const dist = Math.hypot(dx, dy);
            const speed = this.def.speed;

            if (dist > 4) {
                // walking
                const move = speed * dt;
                this.x += (dx / dist) * Math.min(move, dist);
                this.y += (dy / dist) * Math.min(move, dist);
                this.state = 'walking';
                this.idleSince = 0;
                this.applyTransform();
                this.applyWalkFrame(now, dx, dy);
            } else {
                // arrived — idle for a bit, then pick a new target
                if (this.idleSince === 0) this.idleSince = now;
                this.state = 'idle';
                const idleMs = now - this.idleSince;
                this.applyIdleFrame(now, idleMs);
                if (idleMs > 1800 + Math.random() * 2200) {
                    this.pickTarget();
                    this.idleSince = 0;
                }
            }

            // Safety: re-target if we've been walking but have made no
            // progress for a long time (e.g. the modal got resized).
            if (this.state === 'walking' && now - this.lastRetarget > 12000) {
                this.pickTarget();
            }

            this.rafId = requestAnimationFrame(this.loop);
        }

        applyTransform() {
            this.el.style.left = this.x + 'px';
            this.el.style.top  = this.y + 'px';
        }

        applyWalkFrame(now, dx, dy) {
            if (this.def.kind !== 'sprite') {
                // emoji: face direction by flipping if going left
                this.el.style.transform = dx < 0 ? 'translate(-50%, -50%) scaleX(-1)' : 'translate(-50%, -50%)';
                return;
            }
            const dir = this.compass(dx, dy);
            const frames = this.def.frames[dir];
            if (!frames) return;
            // Cycle frames at ~6fps regardless of fps
            const idx = Math.floor(now / 160) % frames.length;
            const [fx, fy] = frames[idx];
            const sz = this.def.frameSize;
            this.el.style.backgroundPosition = `${fx * sz}px ${fy * sz}px`;
        }

        applyIdleFrame(now, idleMs) {
            if (this.def.kind !== 'sprite') return;
            const sz = this.def.frameSize;
            // After 8s of idle, "tired"; after 14s, "sleeping" (cycles).
            // First second: alert; then occasional scratching.
            let frame;
            if (idleMs < 700) {
                frame = this.def.frames.alert[0];
            } else if (idleMs < 4000) {
                const scratch = this.def.frames.scratchSelf;
                const idx = Math.floor(now / 200) % scratch.length;
                frame = scratch[idx];
            } else if (idleMs < 8000) {
                frame = this.def.frames.idle[0];
            } else if (idleMs < 14000) {
                frame = this.def.frames.tired[0];
            } else {
                const sleeping = this.def.frames.sleeping;
                const idx = Math.floor(now / 500) % sleeping.length;
                frame = sleeping[idx];
            }
            const [fx, fy] = frame;
            this.el.style.backgroundPosition = `${fx * sz}px ${fy * sz}px`;
        }

        destroy() {
            if (this.rafId) cancelAnimationFrame(this.rafId);
            this.rafId = null;
            this.el?.remove();
        }
    }

    // ─── Public API ──────────────────────────────────────────────
    let activePet = null;

    function mountPet(container, petId) {
        unmountPet();
        if (!container || !petId || petId === 'none') return;
        const def = PET_DEFS[petId];
        if (!def) return;
        // The pet is positioned absolutely within the container; the
        // container needs position: relative or absolute. .profile-modal
        // already has position:relative via the modal-overlay rules.
        activePet = new Pet(container, def);
    }

    function unmountPet() {
        if (activePet) {
            activePet.destroy();
            activePet = null;
        }
    }

    window.ArcadeProfilePet = { mountPet, unmountPet };
})();
