type PropertyValue = string | number | boolean;
type PropertyControl = HTMLInputElement | HTMLTextAreaElement;

function controlType(value: unknown): string | undefined {
  if (typeof value === "boolean") return "checkbox";
  if (typeof value === "number" && Number.isFinite(value)) return "number";
  if (typeof value === "string") {
    if (/^#[a-f\d]{6}$/i.test(value)) return "color";
    return value.includes("\n") || value.length > 100 ? "textarea" : "text";
  }
  return undefined;
}

function propertyLabel(name: string): string {
  const words = name
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return words ? words[0]!.toUpperCase() + words.slice(1).toLowerCase() : name;
}

/** Primitive controls preserve unsupported values in the saved-input draft. */
export class InputPropertiesForm {
  private readonly fields = new Map<
    string,
    { control: PropertyControl; type: string }
  >();
  private readonly invalid = new Set<string>();
  private readonly message: HTMLElement;
  private text?: string;
  private shape?: string;
  private object: Record<string, unknown> | undefined;

  constructor(
    private readonly root: HTMLElement,
    private readonly change: (text?: string) => void,
  ) {
    this.message = root.ownerDocument.createElement("p");
    this.message.className = "help-text property-message";
  }

  get valid(): boolean {
    return !!this.object && this.invalid.size === 0;
  }

  get hasInvalidDraft(): boolean {
    return this.invalid.size > 0;
  }

  acceptJson(): void {
    this.invalid.clear();
    this.text = undefined;
  }

  sync(text: string, disabled: boolean): void {
    let object: unknown;
    try {
      object = JSON.parse(text);
    } catch {
      /* Keep the raw draft until it is valid. */
    }
    if (!object || typeof object !== "object" || Array.isArray(object)) {
      this.object = undefined;
      this.text = text;
      this.invalid.clear();
      this.message.textContent =
        "The saved input file must contain a valid object.";
      this.message.hidden = false;
      for (const { control } of this.fields.values()) control.disabled = true;
      return;
    }
    this.object = object as Record<string, unknown>;
    const entries = Object.entries(this.object)
      .map(([key, value]) => {
        let type = controlType(value);
        const existing = this.fields.get(key)?.type;
        if (typeof value === "string") {
          if (existing === "textarea") type = existing;
          else if (existing === "text" && !value.includes("\n"))
            type = existing;
        }
        return { key, value, type };
      })
      .filter((entry) => entry.type !== undefined);
    const shape = JSON.stringify(entries.map(({ key, type }) => [key, type]));
    if (text !== this.text) this.invalid.clear();
    if (shape !== this.shape) {
      this.fields.clear();
      const labels = entries.map(({ key, type }) => {
        const label = this.root.ownerDocument.createElement("label");
        label.className = `property-field${type === "checkbox" ? " property-toggle" : ""}`;
        const caption = this.root.ownerDocument.createElement("span");
        caption.textContent = propertyLabel(key);
        const control = this.root.ownerDocument.createElement(
          type === "textarea" ? "textarea" : "input",
        ) as PropertyControl;
        if (type === "textarea") (control as HTMLTextAreaElement).rows = 3;
        else (control as HTMLInputElement).type = type!;
        if (type === "number") (control as HTMLInputElement).step = "any";
        control.setAttribute("data-input-prop", key);
        control.addEventListener("input", () => this.edit(key));
        this.fields.set(key, { control, type: type! });
        label.append(caption, control);
        return label;
      });
      this.root.replaceChildren(...labels, this.message);
      this.shape = shape;
    }
    this.text = text;
    for (const { key, value } of entries) {
      const { control, type } = this.fields.get(key)!;
      control.disabled = disabled;
      if (this.invalid.has(key)) continue;
      control.setAttribute("aria-invalid", "false");
      if (type === "checkbox")
        (control as HTMLInputElement).checked = value as boolean;
      else if (control.value !== String(value)) control.value = String(value);
    }
    this.message.textContent = this.invalid.size
      ? "Enter a valid number to save."
      : entries.length
        ? ""
        : "Edit the saved input file to change nested properties.";
    this.message.hidden = !this.message.textContent;
  }

  private edit(key: string): void {
    const field = this.fields.get(key);
    if (!field || !this.object || field.control.disabled) return;
    let value: PropertyValue = field.control.value;
    if (field.type === "checkbox")
      value = (field.control as HTMLInputElement).checked;
    else if (field.type === "number") {
      value = Number(field.control.value);
      if (!field.control.value.trim() || !Number.isFinite(value)) {
        this.invalid.add(key);
        field.control.setAttribute("aria-invalid", "true");
        this.change();
        return;
      }
    }
    this.invalid.delete(key);
    const text = JSON.stringify({ ...this.object, [key]: value }, null, 2);
    this.text = text;
    this.change(text);
  }
}
