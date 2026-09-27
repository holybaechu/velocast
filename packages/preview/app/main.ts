import "./style.css";
import { PreviewApp } from "../src/preview-app.js";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("preview.ui_missing: #app");
const app = new PreviewApp({ root });
void app.start();
window.addEventListener("pagehide", () => void app.dispose(), { once: true });
