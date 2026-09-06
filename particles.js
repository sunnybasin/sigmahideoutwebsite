const canvas = document.getElementById('particles');
const ctx = canvas.getContext('2d');
let width, height, particles;

const PARTICLE_COUNT_DESKTOP = 90;
const PARTICLE_COUNT_MOBILE = 45;
const LINK_DISTANCE = 130;
const COLOR = '196, 0, 0'; // RGB, no alpha — change this for a different hue

function resize() {
  width = canvas.width = window.innerWidth;
  height = canvas.height = window.innerHeight;
}

function makeParticles() {
  const count = width < 700 ? PARTICLE_COUNT_MOBILE : PARTICLE_COUNT_DESKTOP;
  particles = Array.from({ length: count }, () => ({
    x: Math.random() * width,
    y: Math.random() * height,
    vx: (Math.random() - 0.5) * 0.35,
    vy: (Math.random() - 0.5) * 0.35,
    r: Math.random() * 1.6 + 0.6,
    glow: Math.random() * 0.5 + 0.5
  }));
}

function step() {
  ctx.clearRect(0, 0, width, height);

  for (let i = 0; i < particles.length; i++) {
    for (let j = i + 1; j < particles.length; j++) {
      const a = particles[i], b = particles[j];
      const dx = a.x - b.x, dy = a.y - b.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < LINK_DISTANCE) {
        const alpha = (1 - dist / LINK_DISTANCE) * 0.15;
        ctx.strokeStyle = `rgba(${COLOR}, ${alpha})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
  }

  for (const p of particles) {
    p.x += p.vx;
    p.y += p.vy;

    if (p.x < 0) p.x = width;
    if (p.x > width) p.x = 0;
    if (p.y < 0) p.y = height;
    if (p.y > height) p.y = 0;

    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${COLOR}, ${p.glow})`;
    ctx.shadowColor = `rgba(${COLOR}, 0.8)`;
    ctx.shadowBlur = 6;
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  requestAnimationFrame(step);
}

window.addEventListener('resize', () => {
  resize();
  makeParticles();
});

resize();
makeParticles();
step();
