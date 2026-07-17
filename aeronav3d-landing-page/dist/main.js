const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (t) => t * t * (3 - 2 * t);
const rangeProgress = (start, end, value) => clamp((value - start) / (end - start), 0, 1);

function initNavigation() {
  const nav = document.querySelector("[data-nav]");
  if (!nav) return;

  let isExpanded = true;
  let lastScrollY = window.scrollY;
  let scrollPositionOnCollapse = 0;
  const expandScrollThreshold = 80;

  const setExpanded = (expanded) => {
    isExpanded = expanded;
    nav.classList.toggle("compact", !expanded);
  };

  const update = () => {
    const latest = window.scrollY;
    const previous = lastScrollY;

    if (isExpanded && latest > previous && latest > 150) {
      setExpanded(false);
      scrollPositionOnCollapse = latest;
    } else if (!isExpanded && latest < previous && scrollPositionOnCollapse - latest > expandScrollThreshold) {
      setExpanded(true);
    }

    lastScrollY = latest;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    document.documentElement.style.setProperty("--scroll-progress", max > 0 ? window.scrollY / max : 0);
  };

  nav.addEventListener("click", (event) => {
    if (!isExpanded) {
      event.preventDefault();
      setExpanded(true);
      scrollPositionOnCollapse = window.scrollY;
    }
  });

  update();
  window.addEventListener("scroll", update, { passive: true });
}

function initReveal() {
  const elements = [...document.querySelectorAll("[data-reveal]")];
  elements.forEach((element, index) => {
    element.style.setProperty("--reveal-delay", `${Math.min((index % 5) * 55, 220)}ms`);
  });

  if (!("IntersectionObserver" in window) || prefersReducedMotion) {
    elements.forEach((element) => element.classList.add("is-visible"));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.18, rootMargin: "0px 0px -8% 0px" },
  );

  elements.forEach((element) => observer.observe(element));
}

function latLonToVector(lat, lon) {
  const phi = (lat * Math.PI) / 180;
  const theta = (lon * Math.PI) / 180;
  return {
    x: Math.cos(phi) * Math.sin(theta),
    y: Math.sin(phi),
    z: Math.cos(phi) * Math.cos(theta),
  };
}

function slerpVector(a, b, t) {
  const dot = clamp(a.x * b.x + a.y * b.y + a.z * b.z, -1, 1);
  const omega = Math.acos(dot);
  const sinOmega = Math.sin(omega);
  if (sinOmega < 0.0001) return a;
  const s0 = Math.sin((1 - t) * omega) / sinOmega;
  const s1 = Math.sin(t * omega) / sinOmega;
  return {
    x: a.x * s0 + b.x * s1,
    y: a.y * s0 + b.y * s1,
    z: a.z * s0 + b.z * s1,
  };
}

class GlobeRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.pointer = { x: 0, y: 0 };
    this.targetPointer = { x: 0, y: 0 };
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.points = this.createPoints();
    this.routes = [
      { from: [25.2532, 55.3657], to: [47.4502, -122.3088], label: "Dubai to Seattle" },
      { from: [51.47, -0.4543], to: [40.6413, -73.7781], label: "London to New York" },
      { from: [35.5494, 139.7798], to: [33.9416, -118.4085], label: "Tokyo to Los Angeles" },
      { from: [-33.9399, 151.1753], to: [1.3644, 103.9915], label: "Sydney to Singapore" },
    ];
    this.resize = this.resize.bind(this);
    this.render = this.render.bind(this);
    window.addEventListener("resize", this.resize);
    this.canvas.addEventListener("pointermove", (event) => {
      const rect = this.canvas.getBoundingClientRect();
      this.targetPointer.x = ((event.clientX - rect.left) / rect.width - 0.5) * 0.55;
      this.targetPointer.y = ((event.clientY - rect.top) / rect.height - 0.5) * -0.45;
    });
    this.canvas.addEventListener("pointerleave", () => {
      this.targetPointer.x = 0;
      this.targetPointer.y = 0;
    });
    this.resize();
    requestAnimationFrame(this.render);
  }

  createPoints() {
    const hubs = [
      [25.2532, 55.3657], [47.4502, -122.3088], [51.47, -0.4543],
      [40.6413, -73.7781], [35.5494, 139.7798], [33.9416, -118.4085],
      [1.3644, 103.9915], [48.3538, 11.7861], [49.0097, 2.5479],
      [41.2974, 2.0833], [52.3105, 4.7683], [37.6213, -122.379],
      [25.7959, -80.287], [19.4361, -99.0719], [-33.9399, 151.1753],
      [55.9736, 37.4125], [28.5562, 77.1], [-23.4356, -46.4731],
    ];

    const points = hubs.map(([lat, lon], index) => ({ lat, lon, size: index < 2 ? 2.6 : 1.8, hub: true }));
    for (let i = 0; i < 560; i += 1) {
      const lat = Math.asin(Math.random() * 2 - 1) * (180 / Math.PI);
      const lon = Math.random() * 360 - 180;
      const continentalBias =
        Math.sin((lon + 24) * 0.055) +
        Math.cos((lat - 12) * 0.13) +
        Math.sin((lat + lon) * 0.035);
      if (continentalBias > -0.35 || Math.random() > 0.58) {
        points.push({ lat, lon, size: Math.random() * 1.25 + 0.38, hub: false });
      }
    }
    return points;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    this.canvas.width = Math.floor(this.width * this.dpr);
    this.canvas.height = Math.floor(this.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  projectVector(vector, rotationY, rotationX, radius) {
    const cosY = Math.cos(rotationY);
    const sinY = Math.sin(rotationY);
    const cosX = Math.cos(rotationX);
    const sinX = Math.sin(rotationX);

    let x = vector.x * cosY - vector.z * sinY;
    let z = vector.x * sinY + vector.z * cosY;
    let y = vector.y * cosX - z * sinX;
    z = vector.y * sinX + z * cosX;

    const perspective = 2.65;
    const scale = perspective / (perspective - z);
    return {
      x: this.width / 2 + x * radius * scale,
      y: this.height / 2 - y * radius * scale,
      z,
      scale,
      visible: z > -0.55,
    };
  }

  drawRoute(route, rotationY, rotationX, radius, time, highlight = false) {
    const ctx = this.ctx;
    const from = latLonToVector(route.from[0], route.from[1]);
    const to = latLonToVector(route.to[0], route.to[1]);
    const segments = [];
    for (let i = 0; i <= 64; i += 1) {
      const t = i / 64;
      const point = slerpVector(from, to, t);
      const lift = Math.sin(Math.PI * t) * 0.18;
      const projected = this.projectVector({
        x: point.x * (1 + lift),
        y: point.y * (1 + lift),
        z: point.z * (1 + lift),
      }, rotationY, rotationX, radius);
      segments.push(projected);
    }

    ctx.beginPath();
    let hasStarted = false;
    segments.forEach((point) => {
      if (!point.visible) {
        hasStarted = false;
        return;
      }
      if (!hasStarted) {
        ctx.moveTo(point.x, point.y);
        hasStarted = true;
      } else {
        ctx.lineTo(point.x, point.y);
      }
    });
    ctx.strokeStyle = highlight ? "rgba(255,255,255,0.78)" : "rgba(255,255,255,0.18)";
    ctx.lineWidth = highlight ? 2.2 : 1;
    ctx.stroke();

    if (highlight) {
      const movingPoint = segments[Math.floor(((time * 0.00008) % 1) * (segments.length - 1))];
      if (movingPoint && movingPoint.visible) {
        ctx.beginPath();
        ctx.arc(movingPoint.x, movingPoint.y, 4.8, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,255,255,0.95)";
        ctx.shadowColor = "rgba(248,248,255,0.72)";
        ctx.shadowBlur = 18;
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    }
  }

  render(time = 0) {
    const ctx = this.ctx;
    const radius = Math.min(this.width, this.height) * 0.345;
    this.pointer.x = lerp(this.pointer.x, this.targetPointer.x, 0.045);
    this.pointer.y = lerp(this.pointer.y, this.targetPointer.y, 0.045);
    const rotationY = (prefersReducedMotion ? 0.9 : time * 0.00008) + this.pointer.x;
    const rotationX = -0.16 + this.pointer.y;

    ctx.clearRect(0, 0, this.width, this.height);
    const gradient = ctx.createRadialGradient(this.width * 0.46, this.height * 0.36, radius * 0.1, this.width / 2, this.height / 2, radius * 1.4);
    gradient.addColorStop(0, "rgba(255,255,255,0.22)");
    gradient.addColorStop(0.44, "rgba(166,167,173,0.16)");
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(this.width / 2, this.height / 2, radius * 1.18, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.arc(this.width / 2, this.height / 2, radius, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.24)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.26)";
    ctx.lineWidth = 1.2;
    ctx.stroke();

    for (let lat = -60; lat <= 60; lat += 30) {
      ctx.beginPath();
      let started = false;
      for (let lon = -180; lon <= 180; lon += 4) {
        const projected = this.projectVector(latLonToVector(lat, lon), rotationY, rotationX, radius);
        if (!projected.visible) {
          started = false;
          continue;
        }
        if (!started) {
          ctx.moveTo(projected.x, projected.y);
          started = true;
        } else {
          ctx.lineTo(projected.x, projected.y);
        }
      }
      ctx.strokeStyle = "rgba(255,255,255,0.075)";
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }

    this.points.forEach((point) => {
      const projected = this.projectVector(latLonToVector(point.lat, point.lon), rotationY, rotationX, radius);
      if (!projected.visible) return;
      const alpha = clamp((projected.z + 0.62) / 1.62, 0.05, 1);
      ctx.beginPath();
      ctx.arc(projected.x, projected.y, point.size * projected.scale, 0, Math.PI * 2);
      ctx.fillStyle = point.hub ? `rgba(255,255,255,${0.7 * alpha})` : `rgba(246,245,244,${0.33 * alpha})`;
      ctx.fill();
    });

    this.routes.forEach((route, index) => this.drawRoute(route, rotationY, rotationX, radius, time, index === 0));

    if (!prefersReducedMotion) requestAnimationFrame(this.render);
  }
}

function initCinematicHero() {
  const hero = document.querySelector("[data-cinematic-hero]");
  if (!hero) return;

  const card = hero.querySelector("[data-cinema-card]");
  const phone = hero.querySelector("[data-phone-mockup]");

  const setHeroVar = (name, value) => hero.style.setProperty(name, value);

  const update = () => {
    if (prefersReducedMotion) {
      setHeroVar("--cinema-progress", "0.42");
      setHeroVar("--hero-text-opacity", "1");
      setHeroVar("--hero-text-blur", "0px");
      setHeroVar("--hero-text-scale", "1");
      setHeroVar("--card-y", "0vh");
      setHeroVar("--card-width", window.innerWidth < 768 ? "92vw" : "85vw");
      setHeroVar("--card-height", window.innerWidth < 768 ? "86vh" : "85vh");
      setHeroVar("--card-radius", window.innerWidth < 768 ? "32px" : "40px");
      setHeroVar("--content-opacity", "1");
      setHeroVar("--content-y", "0px");
      setHeroVar("--content-scale", "1");
      setHeroVar("--cta-opacity", "0");
      return;
    }

    const rect = hero.getBoundingClientRect();
    const scrollable = Math.max(hero.offsetHeight - window.innerHeight, 1);
    const p = clamp(-rect.top / scrollable, 0, 1);

    const cardEnter = smoothstep(rangeProgress(0.02, 0.22, p));
    const expand = smoothstep(rangeProgress(0.18, 0.36, p));
    const contentIn = smoothstep(rangeProgress(0.28, 0.4, p));
    const contentOut = smoothstep(rangeProgress(0.68, 0.82, p));
    const pullback = smoothstep(rangeProgress(0.72, 0.88, p));
    const ctaIn = smoothstep(rangeProgress(0.7, 0.8, p));
    const ctaOut = smoothstep(rangeProgress(0.94, 1, p));
    const exit = smoothstep(rangeProgress(0.92, 1, p));
    const content = contentIn * (1 - contentOut);
    const cta = ctaIn * (1 - ctaOut);
    const isMobile = window.innerWidth < 768;

    const expandedWidth = 100;
    const expandedHeight = 100;
    const pullWidth = isMobile ? 92 : 85;
    const pullHeight = isMobile ? 86 : 85;
    const cardWidth = lerp(88, expandedWidth, expand);
    const cardHeight = lerp(86, expandedHeight, expand);

    setHeroVar("--cinema-progress", p.toFixed(4));
    setHeroVar("--hero-text-opacity", lerp(1, 0.16, cardEnter).toFixed(3));
    setHeroVar("--hero-text-blur", `${lerp(0, 20, cardEnter).toFixed(2)}px`);
    setHeroVar("--hero-text-scale", lerp(1, 1.15, cardEnter).toFixed(3));
    setHeroVar("--hero-text-y", `${lerp(0, -20, cardEnter).toFixed(2)}px`);
    setHeroVar("--card-y", `${(lerp(112, 0, cardEnter) + lerp(0, -124, exit)).toFixed(2)}vh`);
    setHeroVar("--card-width", `${lerp(cardWidth, pullWidth, pullback).toFixed(2)}vw`);
    setHeroVar("--card-height", `${lerp(cardHeight, pullHeight, pullback).toFixed(2)}vh`);
    setHeroVar("--card-radius", `${lerp(40, isMobile ? 32 : 40, pullback).toFixed(2)}px`);
    setHeroVar("--card-scale", lerp(1, 0.9, contentOut).toFixed(3));
    setHeroVar("--content-opacity", content.toFixed(3));
    setHeroVar("--content-y", `${lerp(42, -34, contentOut).toFixed(2)}px`);
    setHeroVar("--content-scale", lerp(0.96, 0.9, contentOut).toFixed(3));
    setHeroVar("--cta-opacity", cta.toFixed(3));
    setHeroVar("--cta-blur", `${lerp(30, 0, ctaIn).toFixed(2)}px`);
    setHeroVar("--cta-scale", lerp(0.82, 1, ctaIn).toFixed(3));
  };

  hero.addEventListener("pointermove", (event) => {
    if (!card || prefersReducedMotion || event.pointerType === "touch") return;
    const rect = card.getBoundingClientRect();
    const mouseX = clamp(event.clientX - rect.left, 0, rect.width);
    const mouseY = clamp(event.clientY - rect.top, 0, rect.height);
    card.style.setProperty("--mouse-x", `${mouseX}px`);
    card.style.setProperty("--mouse-y", `${mouseY}px`);

    if (phone) {
      const x = (event.clientX / window.innerWidth - 0.5) * 2;
      const y = (event.clientY / window.innerHeight - 0.5) * 2;
      phone.style.setProperty("--phone-rotate-y", `${(x * 10).toFixed(2)}deg`);
      phone.style.setProperty("--phone-rotate-x", `${(-y * 10).toFixed(2)}deg`);
    }
  });

  hero.addEventListener("pointerleave", () => {
    if (phone) {
      phone.style.setProperty("--phone-rotate-y", "0deg");
      phone.style.setProperty("--phone-rotate-x", "0deg");
    }
  });

  update();
  window.addEventListener("scroll", update, { passive: true });
  window.addEventListener("resize", update);
}

function initSlideProgress() {
  const slides = [...document.querySelectorAll(".slide")];
  const update = () => {
    slides.forEach((slide) => {
      const rect = slide.getBoundingClientRect();
      const progress = clamp((window.innerHeight - rect.top) / (window.innerHeight + rect.height), 0, 1);
      slide.style.setProperty("--local-progress", progress);
    });
  };
  update();
  window.addEventListener("scroll", update, { passive: true });
  window.addEventListener("resize", update);
}

function initContactModal() {
  const modal = document.querySelector("[data-contact-modal]");
  if (!modal) return;

  const openers = [...document.querySelectorAll("[data-contact-trigger]")];
  const closeButtons = [...modal.querySelectorAll("[data-contact-close]")];
  const close = () => {
    modal.hidden = true;
    document.body.classList.remove("modal-open");
  };
  const open = (event) => {
    if (event) event.preventDefault();
    modal.hidden = false;
    document.body.classList.add("modal-open");
    const closeButton = modal.querySelector("[data-contact-close]");
    if (closeButton) closeButton.focus({ preventScroll: true });
  };

  openers.forEach((opener) => opener.addEventListener("click", open));
  closeButtons.forEach((button) => button.addEventListener("click", close));
  modal.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.hidden) close();
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initNavigation();
  initReveal();
  initCinematicHero();
  initSlideProgress();
  initContactModal();

  const globe = document.getElementById("globeCanvas");
  if (globe) new GlobeRenderer(globe);
});
