/** @odoo-module **/

import { Component } from "@odoo/owl";

export class DashboardPagination extends Component {
    static template = "wyn_hr_dashboard.DashboardPagination";
    static props = {
        currentPage: { type: Number },
        totalPages: { type: Number },
        onPageChange: { type: Function },
    };
}
