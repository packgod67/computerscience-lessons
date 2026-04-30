// Profile minigame widget — embeds a tiny playable game inside the
// profile modal. Three options:
//   - snake: classic 12x12 snake, arrow keys / wasd
//   - 2048:  4x4 2048 with arrow keys
//   - memory: 4x4 emoji memory match
// Each game is self-contained; no Firestore writes (purely local play).

(function () {
    const GAMES = {
        snake:  mountSnake,
        '2048': mount2048,
        memory: mountMemory,
    };

    function mount(target, gameId) {
        if (!target) return;
        const fn = GAMES[gameId];
        if (!fn) { target.innerHTML = ''; return; }
        target.innerHTML = '';
        try { fn(target); } catch (e) { console.warn('minigame failed', e); }
    }

    // ─── Snake ────────────────────────────────────────────────────
    function mountSnake(target) {
        const SIZE = 12, CELL = 18;
        const wrap = document.createElement('div');
        wrap.className = 'profile-minigame-wrap';
        const canvas = document.createElement('canvas');
        canvas.width = SIZE * CELL;
        canvas.height = SIZE * CELL;
        canvas.tabIndex = 0;
        canvas.className = 'profile-minigame-canvas';
        const score = document.createElement('div');
        score.className = 'profile-minigame-score';
        score.textContent = 'Snake — click to play, arrows to move';
        wrap.appendChild(score);
        wrap.appendChild(canvas);
        target.appendChild(wrap);

        let snake = [{x:6, y:6}];
        let dir = {x: 1, y: 0};
        let food = randCell();
        let dead = false;
        let s = 0;
        const ctx = canvas.getContext('2d');

        function randCell() {
            return { x: Math.floor(Math.random() * SIZE), y: Math.floor(Math.random() * SIZE) };
        }
        function tick() {
            if (dead) return;
            const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
            if (head.x < 0 || head.x >= SIZE || head.y < 0 || head.y >= SIZE) { dead = true; }
            for (const seg of snake) if (seg.x === head.x && seg.y === head.y) { dead = true; }
            if (dead) {
                score.textContent = `Game over — score ${s}. Click to restart.`;
                canvas.addEventListener('click', restart, { once: true });
                return;
            }
            snake.unshift(head);
            if (head.x === food.x && head.y === food.y) {
                s++;
                score.textContent = `Score ${s}`;
                food = randCell();
            } else {
                snake.pop();
            }
            draw();
            setTimeout(tick, 130);
        }
        function draw() {
            ctx.fillStyle = '#181820'; ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#ef4444'; ctx.fillRect(food.x * CELL, food.y * CELL, CELL - 2, CELL - 2);
            ctx.fillStyle = '#7c3aed';
            for (const seg of snake) ctx.fillRect(seg.x * CELL, seg.y * CELL, CELL - 2, CELL - 2);
        }
        function restart() {
            snake = [{x:6, y:6}]; dir = {x:1, y:0}; food = randCell(); dead = false; s = 0;
            score.textContent = 'Score 0';
            tick();
        }
        canvas.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowUp'    || e.key === 'w') dir = { x: 0, y: -1 };
            if (e.key === 'ArrowDown'  || e.key === 's') dir = { x: 0, y:  1 };
            if (e.key === 'ArrowLeft'  || e.key === 'a') dir = { x: -1, y: 0 };
            if (e.key === 'ArrowRight' || e.key === 'd') dir = { x:  1, y: 0 };
            e.preventDefault();
        });
        canvas.addEventListener('click', () => canvas.focus());
        draw();
        tick();
    }

    // ─── 2048 ─────────────────────────────────────────────────────
    function mount2048(target) {
        const wrap = document.createElement('div');
        wrap.className = 'profile-minigame-wrap';
        const score = document.createElement('div');
        score.className = 'profile-minigame-score';
        score.textContent = '2048 — arrow keys to merge';
        const grid = document.createElement('div');
        grid.className = 'profile-minigame-2048-grid';
        grid.tabIndex = 0;
        wrap.appendChild(score);
        wrap.appendChild(grid);
        target.appendChild(wrap);

        let board = Array.from({length: 4}, () => Array(4).fill(0));
        let s = 0;
        function spawn() {
            const empty = [];
            for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) if (!board[y][x]) empty.push([x, y]);
            if (!empty.length) return;
            const [x, y] = empty[Math.floor(Math.random() * empty.length)];
            board[y][x] = Math.random() < 0.9 ? 2 : 4;
        }
        function draw() {
            grid.innerHTML = '';
            for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
                const v = board[y][x];
                const cell = document.createElement('div');
                cell.className = 'profile-minigame-2048-cell';
                cell.textContent = v || '';
                cell.dataset.v = v;
                grid.appendChild(cell);
            }
        }
        function rotate(dir) {
            for (let i = 0; i < dir; i++) {
                const next = Array.from({length: 4}, () => Array(4).fill(0));
                for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) next[x][3 - y] = board[y][x];
                board = next;
            }
        }
        function slideLeft() {
            for (let y = 0; y < 4; y++) {
                const row = board[y].filter(v => v);
                for (let i = 0; i < row.length - 1; i++) {
                    if (row[i] === row[i+1]) { row[i] *= 2; s += row[i]; row.splice(i+1, 1); }
                }
                while (row.length < 4) row.push(0);
                board[y] = row;
            }
        }
        function move(dir) {
            const before = JSON.stringify(board);
            rotate(dir);
            slideLeft();
            rotate((4 - dir) % 4);
            const after = JSON.stringify(board);
            if (before !== after) {
                spawn();
                score.textContent = `Score ${s}`;
            }
            draw();
        }
        grid.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowLeft')  { move(0); e.preventDefault(); }
            if (e.key === 'ArrowUp')    { move(1); e.preventDefault(); }
            if (e.key === 'ArrowRight') { move(2); e.preventDefault(); }
            if (e.key === 'ArrowDown')  { move(3); e.preventDefault(); }
        });
        grid.addEventListener('click', () => grid.focus());
        spawn(); spawn(); draw();
    }

    // ─── Memory match ────────────────────────────────────────────
    function mountMemory(target) {
        const SYMBOLS = ['🐱','🐶','🦊','🐼','🦄','🐉','🐙','🦋'];
        const deck = SYMBOLS.concat(SYMBOLS).sort(() => Math.random() - 0.5);
        const wrap = document.createElement('div');
        wrap.className = 'profile-minigame-wrap';
        const score = document.createElement('div');
        score.className = 'profile-minigame-score';
        score.textContent = 'Memory — match all pairs';
        const grid = document.createElement('div');
        grid.className = 'profile-minigame-memory-grid';
        wrap.appendChild(score);
        wrap.appendChild(grid);
        target.appendChild(wrap);

        let flipped = [];
        let matched = new Set();
        let moves = 0;
        deck.forEach((sym, i) => {
            const tile = document.createElement('button');
            tile.className = 'profile-minigame-memory-tile';
            tile.dataset.sym = sym;
            tile.dataset.i = i;
            tile.textContent = '?';
            tile.addEventListener('click', () => {
                if (matched.has(i) || flipped.find(f => f.dataset.i == i) || flipped.length >= 2) return;
                tile.textContent = sym;
                tile.classList.add('flipped');
                flipped.push(tile);
                if (flipped.length === 2) {
                    moves++;
                    score.textContent = `Moves: ${moves}`;
                    if (flipped[0].dataset.sym === flipped[1].dataset.sym) {
                        matched.add(+flipped[0].dataset.i);
                        matched.add(+flipped[1].dataset.i);
                        flipped.forEach(t => t.classList.add('matched'));
                        flipped = [];
                        if (matched.size === deck.length) {
                            score.textContent = `Done in ${moves} moves! 🎉`;
                        }
                    } else {
                        setTimeout(() => {
                            flipped.forEach(t => { t.textContent = '?'; t.classList.remove('flipped'); });
                            flipped = [];
                        }, 700);
                    }
                }
            });
            grid.appendChild(tile);
        });
    }

    window.ArcadeMinigame = { mount };
})();
