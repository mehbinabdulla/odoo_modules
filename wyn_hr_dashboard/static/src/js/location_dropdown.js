/** @odoo-module **/

import { Component, useState } from "@odoo/owl";

export class LocationDropdown extends Component {
  static template = "wyn_hr_dashboard.LocationDropdown";
  static props = {
    selectedId: { type: [String, Number] },
    options: { type: Array },
    onSelect: { type: Function },
  };

  setup() {
    this.state = useState({
      isOpen: false,
    });
  }

  get selectedName() {
    if (this.props.selectedId === "all") return "All Locations";
    const loc = this.props.options.find((l) => l.id == this.props.selectedId);
    return loc ? loc.name : "All Locations";
  }

  toggle(ev) {
    ev.stopPropagation();
    this.state.isOpen = !this.state.isOpen;
    if (this.state.isOpen) {
      const close = () => {
        this.state.isOpen = false;
        window.removeEventListener("click", close);
      };
      window.addEventListener("click", close);
    }
  }

  select(id) {
    this.props.onSelect(id);
    this.state.isOpen = false;
  }
}
