/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface GuideStep {
  id: string;
  title: string;
  description: string;
  selector: string;
  actionType: "focus" | "input" | "click" | "any";
  actionValue?: string;
  tipPosition: "top" | "bottom" | "left" | "right";
  highlightStyle: "pulse" | "solid" | "glow";
}

export interface Guide {
  url: string;
  title: string;
  description: string;
  steps: GuideStep[];
}

export interface BusinessField {
  id: string;
  label: string;
  selector: string;
  type: "text" | "number" | "select" | "button" | "textarea" | "checkbox";
  placeholder?: string;
  options?: string[];
  defaultValue?: string;
}

export interface MockPage {
  url: string;
  title: string;
  description: string;
  fields: BusinessField[];
}
