// Hero background: Paper Shaders "god rays" (Linear preset), MIT-licensed,
// vendored under /assets/vendor/paper-shaders/. Without JavaScript or WebGL
// the hero simply keeps its plain dark background.
import { ShaderMount } from "/assets/vendor/paper-shaders/shader-mount.js";
import { godRaysFragmentShader } from "/assets/vendor/paper-shaders/shaders/god-rays.js";
import { getShaderColorFromString } from "/assets/vendor/paper-shaders/get-shader-color-from-string.js";
import { getShaderNoiseTexture } from "/assets/vendor/paper-shaders/get-shader-noise-texture.js";
import {
  ShaderFitOptions,
  defaultObjectSizing,
} from "/assets/vendor/paper-shaders/shader-sizing.js";

// Name the visitor's platform on the download buttons; both installers live
// on the same releases page, so only the label changes.
{
  const platform = (
    navigator.userAgentData?.platform ||
    navigator.platform ||
    ""
  ).toLowerCase();
  const os = platform.includes("mac")
    ? "macOS"
    : platform.includes("win")
      ? "Windows"
      : "";
  if (os) {
    for (const label of document.querySelectorAll("[data-download-label]")) {
      label.textContent = `Download for ${os}`;
    }
  }
}

const hero = document.querySelector(".hero");
if (hero) {
  // The library injects an inline <style> unless one is already marked; the
  // same rules live in styles.css, so pre-marking keeps CSP's style-src 'self'.
  if (!document.querySelector("style[data-paper-shader]")) {
    const marker = document.createElement("style");
    marker.setAttribute("data-paper-shader", "");
    document.head.prepend(marker);
  }

  const container = document.createElement("div");
  container.className = "hero-lanes-gl";
  container.setAttribute("aria-hidden", "true");
  hero.prepend(container);

  const SPEED = 0.5;
  const uniforms = {
    u_colorBack: getShaderColorFromString("#000000"),
    u_colorBloom: getShaderColorFromString("#ededed"),
    u_colors: ["#ffffff1f", "#ffffff3d", "#ffffff29"].map(getShaderColorFromString),
    u_colorsCount: 3,
    u_density: 0.41,
    u_spotty: 0.25,
    u_midSize: 0.1,
    u_midIntensity: 0.75,
    u_intensity: 0.79,
    u_bloom: 1,
    u_noiseTexture: getShaderNoiseTexture(),
    // A fixed world keeps the composition identical at every viewport size:
    // narrow screens crop the sides instead of pulling the ray origin into
    // view in the middle of the copy.
    u_fit: ShaderFitOptions.cover,
    u_scale: 1,
    u_rotation: 0,
    u_offsetX: 0.2,
    u_offsetY: -0.8,
    u_originX: defaultObjectSizing.originX,
    u_originY: defaultObjectSizing.originY,
    u_worldWidth: 1440,
    u_worldHeight: 1020,
  };

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  (async () => {
    try {
      // The noise texture is an async-decoding data-URI image, and ShaderMount
      // requires it to be fully loaded before mounting.
      const noise = uniforms.u_noiseTexture;
      if (noise && !noise.complete) await noise.decode();
      const mount = new ShaderMount(
        container,
        godRaysFragmentShader,
        uniforms,
        undefined,
        reducedMotion.matches ? 0 : SPEED,
      );
      reducedMotion.addEventListener?.("change", () => {
        mount.setSpeed(reducedMotion.matches ? 0 : SPEED);
      });
      document.body.classList.add("has-hero-gl");
    } catch {
      container.remove();
    }
  })();
}
