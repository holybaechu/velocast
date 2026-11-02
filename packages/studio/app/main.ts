import "./style.css";
import { StudioApp } from "../src/studio-app.js";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("studio.ui_missing: #app");
const app = new StudioApp({ root });
void app.start();
window.addEventListener("pagehide", () => void app.dispose(), { once: true });
