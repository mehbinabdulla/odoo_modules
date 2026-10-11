/** @odoo-module **/

import {
  Component,
  useState,
  onWillStart,
  useEffect,
  useRef,
  onWillUnmount,
} from "@odoo/owl";
import { registry } from "@web/core/registry";
import { user } from "@web/core/user";
import { useService } from "@web/core/utils/hooks";
import { loadJS } from "@web/core/assets";
import { DashboardPagination } from "./pagination";
import { LocationDropdown } from "./location_dropdown";

function formatToday() {
  const date = new Date();
  return {
    day: date.toLocaleDateString("en-GB", { weekday: "long" }),
    date: date.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
    }),
  };
}

function formatDuration(hoursFloat) {
  if (typeof hoursFloat !== "number" || isNaN(hoursFloat)) {
    return "-";
  }
  const totalMins = Math.round(hoursFloat * 60);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  const hStr = h.toString().padStart(2, "0");
  const mStr = m.toString().padStart(2, "0");
  return `${hStr}h ${mStr}m`;
}

function formatTranslatedField(field) {
  if (typeof field === "object" && field !== null) {
    const lang = user.lang || "en_US";
    return field[lang] || field.en_US || Object.values(field)[0] || "";
  }
  return field || "";
}

export class HrDashboard extends Component {
  static template = "wyn_hr_dashboard.HrDashboard";
  static props = ["*"];
  static components = { DashboardPagination, LocationDropdown };

  setup() {
    this.orm = useService("orm");
    this.chartRef = useRef("attendanceChart");
    this.deptChartRef = useRef("deptChart");
    this.genderChartRef = useRef("genderChart");
    this.nationalityChartRef = useRef("nationalityChart");
    this.chart = null;
    this.deptChart = null;
    this.genderChart = null;
    this.nationalityChart = null;
    this.amChartsLoaded = false;

    this.state = useState({
      loading: true,
      today: formatToday(),
      totalEmployees: 0,
      presentToday: 0,
      onLeave: 0,
      pendingLeaves: 0,
      pendingAllocations: 0,
      totalAttendance: 0,
      leaveRequests: [],
      allocationList: [],
      attendanceList: [],
      userName: user.name,
      pageSize: 5,
      leavePage: 1,
      attendancePage: 1,
      allocationPage: 1,
      locationPage: 1,
      selectedLocationId: "all",
      graphPeriod: "week",
      attendanceStats: {
        last_7_days: [],
        last_30_days: [],
      },
      deptDistribution: [],
      genderDistribution: [],
      nationalityDistribution: [],
      workLocations: [],
      locationEmployees: [],
      totalLocationEmployees: 0,
      recruitmentEnabled: false,
      jobPositions: [],
      totalRecruitingApps: 0,
      nationalityView: "map", // "map" or "donut"
    });

    onWillStart(async () => {
      await loadJS("/web/static/lib/Chart/Chart.js");
      try {
        await Promise.all([
          loadJS("https://cdn.amcharts.com/lib/5/index.js"),
          loadJS("https://cdn.amcharts.com/lib/5/map.js"),
          loadJS("https://cdn.amcharts.com/lib/5/geodata/worldLow.js"),
          loadJS("https://cdn.amcharts.com/lib/5/themes/Animated.js"),
        ]);
        this.amChartsLoaded = true;
      } catch (e) {
        console.warn("amCharts failed to load:", e);
      }

      await this._fetchEmployeeName();
      await this._loadDashboardData();
    });

    onWillUnmount(() => {
      if (this.nationalityChart && this.nationalityChart.dispose) {
        this.nationalityChart.dispose();
      }
    });

    useEffect(
      () => { this._renderChart(); },
      () => [this.state.graphPeriod, this.state.loading, this.state.attendanceStats]
    );

    useEffect(
      () => { this._renderDeptChart(); },
      () => [this.state.loading, this.state.deptDistribution]
    );

    useEffect(
      () => { this._renderGenderChart(); },
      () => [this.state.loading, this.state.genderDistribution]
    );

    useEffect(
      () => { this._renderNationalityChart(); },
      () => [this.state.nationalityView, this.state.loading, this.state.nationalityDistribution]
    );
  }

  async _fetchEmployeeName() {
    try {
      const employee = await this.orm.searchRead(
        "hr.employee",
        [["user_id", "=", user.userId]],
        ["name"],
        { limit: 1 },
      );
      if (employee.length > 0) {
        this.state.userName = employee[0].name;
      }
    } catch (error) {
      console.warn("Failed to fetch employee name via ORM:", error);
    }
  }

  async _loadDashboardData(listType = "all") {
    try {
      const params = new URLSearchParams({
        leave_limit: this.state.pageSize,
        leave_offset: (this.state.leavePage - 1) * this.state.pageSize,
        attendance_limit: this.state.pageSize,
        attendance_offset:
          (this.state.attendancePage - 1) * this.state.pageSize,
        allocation_limit: this.state.pageSize,
        allocation_offset:
          (this.state.allocationPage - 1) * this.state.pageSize,
        location_limit: this.state.pageSize,
        location_offset: (this.state.locationPage - 1) * this.state.pageSize,
        location_id: this.state.selectedLocationId,
        list_type: listType, // Send listType to backend if we want to optimize later
      });

      const res = await fetch(
        `/wyn_hr_dashboard/dashboard_data?${params.toString()}`,
        {
          method: "GET",
          headers: { "Content-Type": "application/json" },
        },
      );

      if (!res.ok) {
        console.error("HR Dashboard: failed to fetch data", res.status);
        return;
      }

      const data = await res.json();

      if (listType === "all") {
        this.state.totalEmployees = data.kpis.total_employees;
        this.state.presentToday = data.kpis.present_today;
        this.state.onLeave = data.kpis.on_leave;
        this.state.pendingLeaves = data.kpis.pending_leaves;
        this.state.pendingAllocations = data.kpis.pending_allocations;
        this.state.totalAttendance = data.kpis.total_attendance;
      }

      if (listType === "all" || listType === "leave") {
        this.state.leaveRequests = (data.leave_requests || []).map((r) => ({
          id: r.id,
          employee: r.employee,
          employeeImg: r.employeeImg,
          initials: r.initials,
          type: formatTranslatedField(r.type),
          dates: r.dates,
          state: r.state,
          stateLabel: r.state_label,
        }));
      }

      if (listType === "all" || listType === "allocation") {
        this.state.allocationList = (data.allocations || []).map((r) => ({
          id: r.id,
          employee: r.employee,
          employeeImg: r.employeeImg,
          initials: r.initials,
          type: formatTranslatedField(r.type),
          duration: r.duration,
          state: r.state,
          stateLabel: r.state_label,
        }));
      }

      if (listType === "all" || listType === "attendance") {
        this.state.attendanceList = (data.attendance || []).map((r) => ({
          id: r.id,
          employee: r.employee,
          employeeImg: r.employeeImg,
          initials: r.initials,
          checkIn: r.check_in,
          checkOut: r.check_out,
          workHours: formatDuration(r.worked_hours),
          status: r.status,
          statusLabel: r.status_label,
        }));
      }

      if (listType === "all") {
        this.state.attendanceStats = data.attendance_stats || {
          last_7_days: [],
          last_30_days: [],
        };
        this.state.deptDistribution = data.dept_distribution || [];
        this.state.genderDistribution = data.gender_distribution || [];
        this.state.nationalityDistribution = data.nationality_distribution || [];
        this.state.workLocations = (data.work_locations || []).map((l) => ({
          ...l,
          name: formatTranslatedField(l.name),
        }));
        this.state.totalRecruitingApps = data.kpis.total_recruiting_apps;
        this.state.recruitmentEnabled = data.recruitment_enabled;
        this.state.jobPositions = (data.job_positions || []).map((j) => ({
          ...j,
          name: formatTranslatedField(j.name),
        }));
      }

      if (listType === "all" || listType === "location") {
        this.state.totalLocationEmployees = data.kpis.total_location_employees;
        this.state.locationEmployees = (data.location_employees || []).map(
          (r) => ({
            id: r.id,
            name: r.name,
            job_title: r.job_title,
            location: formatTranslatedField(r.location),
            employeeImg: r.employeeImg,
            initials: r.initials,
          }),
        );
      }

      let needsReload = false;
      if (this.state.leavePage > this.totalLeavePages) {
        this.state.leavePage = this.totalLeavePages;
        if (listType === "all" || listType === "leave") needsReload = true;
      }
      if (this.state.attendancePage > this.totalAttendancePages) {
        this.state.attendancePage = this.totalAttendancePages;
        if (listType === "all" || listType === "attendance") needsReload = true;
      }
      if (this.state.allocationPage > this.totalAllocationPages) {
        this.state.allocationPage = this.totalAllocationPages;
        if (listType === "all" || listType === "allocation") needsReload = true;
      }
      if (this.state.locationPage > this.totalLocationPages) {
        this.state.locationPage = this.totalLocationPages;
        if (listType === "all" || listType === "location") needsReload = true;
      }

      if (needsReload) {
        return this._loadDashboardData(listType);
      }
    } catch (err) {
      console.error("HR Dashboard: unexpected error", err);
    } finally {
      this.state.loading = false;
    }
  }

  _renderChart() {
    if (!this.chartRef.el) return;
    if (!window.Chart) {
      console.error("Chart.js not found. Attendance graph cannot be rendered.");
      return;
    }

    if (this.chart) {
      this.chart.destroy();
    }

    const ctx = this.chartRef.el.getContext("2d");
    const dataKey =
      this.state.graphPeriod === "week" ? "last_7_days" : "last_30_days";
    const stats = this.state.attendanceStats[dataKey] || [];

    const labels = stats.map((s) => s.day);
    const attendanceValues = stats.map((s) => s.attendance_count);
    const leaveValues = stats.map((s) => s.leave_count);

    const attLineColor = "#118C42";
    const leaveLineColor = "#D42A46";

    const gradientAtt = ctx.createLinearGradient(0, 0, 0, 300);
    gradientAtt.addColorStop(0, "rgba(17, 140, 66, 0.4)");
    gradientAtt.addColorStop(1, "rgba(17, 140, 66, 0)");

    const gradientLeave = ctx.createLinearGradient(0, 0, 0, 300);
    gradientLeave.addColorStop(0, "rgba(212, 42, 70, 0.2)");
    gradientLeave.addColorStop(1, "rgba(212, 42, 70, 0)");

    this.chart = new window.Chart(ctx, {
      type: "line",
      data: {
        labels: labels,
        datasets: [
          {
            label: "Present",
            data: attendanceValues,
            fill: true,
            backgroundColor: gradientAtt,
            borderColor: attLineColor,
            tension: 0.4,
            pointBackgroundColor: attLineColor,
            pointRadius: this.state.graphPeriod === "week" ? 4 : 2,
            borderWidth: 2,
          },
          {
            label: "On Leave",
            data: leaveValues,
            fill: true,
            backgroundColor: gradientLeave,
            borderColor: leaveLineColor,
            tension: 0.4,
            pointBackgroundColor: leaveLineColor,
            pointRadius: this.state.graphPeriod === "week" ? 4 : 2,
            borderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: "index",
          intersect: false,
        },
        plugins: {
          legend: {
            display: true,
            position: "top",
            align: "end",
            labels: {
              boxWidth: 12,
              font: { size: 10 },
            },
          },
          tooltip: {
            mode: "index",
            intersect: false,
            backgroundColor: "rgba(255, 255, 255, 0.9)",
            titleColor: "#333",
            bodyColor: "#666",
            borderWidth: 1,
            borderColor: "#ddd",
            callbacks: {
              title: (tooltipItems) => {
                const index = tooltipItems[0].dataIndex;
                return stats[index].full_day;
              },
            },
          },
        },
        scales: {
          y: {
            beginAtZero: true,
            grid: { color: "rgba(0,0,0,0.05)" },
            ticks: { stepSize: 1, color: "#999", font: { size: 10 } },
          },
          x: {
            grid: { display: false },
            ticks: {
              color: "#999",
              font: { size: 10 },
              maxRotation: 45,
              minRotation: 0,
              autoSkip: true,
              maxTicksLimit: 10,
            },
          },
        },
      },
      plugins: [
        {
          id: "verticalLine",
          afterDraw: (chart) => {
            if (chart.tooltip?._active?.length) {
              const x = chart.tooltip._active[0].element.x;
              const yAxis = chart.scales.y;
              const ctx = chart.ctx;
              ctx.save();
              ctx.beginPath();
              ctx.setLineDash([5, 5]);
              ctx.moveTo(x, yAxis.top);
              ctx.lineTo(x, yAxis.bottom);
              ctx.lineWidth = 1;
              ctx.strokeStyle = "rgba(0, 0, 0, 0.2)";
              ctx.stroke();
              ctx.restore();
            }
          },
        },
      ],
    });
  }

  _renderDeptChart() {
    if (!this.deptChartRef.el) return;
    if (!window.Chart) return;

    if (this.deptChart) {
      this.deptChart.destroy();
    }

    const ctx = this.deptChartRef.el.getContext("2d");
    const stats = this.state.deptDistribution || [];

    const labels = stats.map((s) => formatTranslatedField(s.name));
    const dataValues = stats.map((s) => s.count);

    const colors = [
      "rgba(48, 97, 175, 0.85)",
      "rgba(17, 140, 66, 0.85)",
      "rgba(212, 42, 70, 0.85)",
      "rgba(196, 138, 23, 0.85)",
      "rgba(52, 164, 202, 0.85)",
      "rgba(113, 75, 103, 0.85)",
      "rgba(233, 115, 0, 0.85)",
    ];

    this.deptChart = new window.Chart(ctx, {
      type: "polarArea",
      data: {
        labels: labels,
        datasets: [
          {
            data: dataValues,
            backgroundColor: colors,
            borderColor: "white",
            borderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        onClick: (ev, elements) => {
          if (elements.length > 0) {
            const index = elements[0].index;
            const dept = stats[index];
            if (dept && dept.id) {
              this._openDepatmentEmployees(
                dept.id,
                formatTranslatedField(dept.name)
              );
            }
          }
        },
        onHover: (ev, elements) => {
          ev.native.target.style.cursor = elements.length > 0 ? "pointer" : "default";
        },
        plugins: {
          legend: {
            display: true,
            position: "bottom",
            labels: {
              boxWidth: 10,
              font: { size: 10 },
              padding: 15,
            },
          },
          tooltip: {
            backgroundColor: "rgba(255, 255, 255, 0.9)",
            titleColor: "#333",
            bodyColor: "#666",
            borderWidth: 1,
            borderColor: "#ddd",
          },
        },
        scales: {
          r: {
            ticks: { display: false },
            grid: { color: "rgba(0,0,0,0.05)" },
          },
        },
      },
    });
  }

  _renderGenderChart() {
    if (!this.genderChartRef.el) return;
    if (!window.Chart) return;

    if (this.genderChart) {
      this.genderChart.destroy();
    }

    const ctx = this.genderChartRef.el.getContext("2d");
    const stats = this.state.genderDistribution || [];

    const labels = stats.map((s) => {
      const name = s.name || "Unknown";
      return name.charAt(0).toUpperCase() + name.slice(1);
    });
    const dataValues = stats.map((s) => s.count);

    const colors = [
      "rgba(48, 97, 175, 0.85)",
      "rgba(212, 42, 70, 0.85)",
      "rgba(52, 164, 202, 0.85)",
      "rgba(132, 141, 156, 0.85)",
    ];

    this.genderChart = new window.Chart(ctx, {
      type: "doughnut",
      data: {
        labels: labels,
        datasets: [
          {
            data: dataValues,
            backgroundColor: colors,
            borderColor: "white",
            borderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "70%",
        onClick: (ev, elements) => {
          if (elements.length > 0) {
            const index = elements[0].index;
            const gender = stats[index];
            if (gender && gender.name) {
              const label = labels[index];
              this._openGenderEmployees(gender.name, label);
            }
          }
        },
        onHover: (ev, elements) => {
          ev.native.target.style.cursor =
            elements.length > 0 ? "pointer" : "default";
        },
        plugins: {
          legend: {
            display: true,
            position: "bottom",
            labels: {
              boxWidth: 10,
              font: { size: 10 },
              padding: 15,
            },
          },
          tooltip: {
            backgroundColor: "rgba(255, 255, 255, 0.9)",
            titleColor: "#333",
            bodyColor: "#666",
            borderWidth: 1,
            borderColor: "#ddd",
          },
        },
      },
    });
  }

  _renderNationalityChart() {
    if (!this.nationalityChartRef.el) return;

    // Cleanup previous chart
    if (this.nationalityChart) {
      if (this.nationalityChart.dispose) {
        this.nationalityChart.dispose();
      } else if (this.nationalityChart.destroy) {
        this.nationalityChart.destroy();
      }
      this.nationalityChart = null;
    }

    const stats = this.state.nationalityDistribution || [];
    if (stats.length === 0) return;

    if (this.state.nationalityView === "donut") {
      const ctx = this.nationalityChartRef.el.getContext("2d");
      this._renderNationalityDoughnut(ctx, stats);
      return;
    }

    if (!this.amChartsLoaded || !window.am5) return;

    // Create root element
    const root = am5.Root.new(this.nationalityChartRef.el);
    this.nationalityChart = root;

    // Hide amCharts logo
    if (root._logo) {
      root._logo.set("forceHidden", true);
    }

    // Set themes
    root.setThemes([am5themes_Animated.new(root)]);

    // Create map chart
    const chart = root.container.children.push(
      am5map.MapChart.new(root, {
        panX: "translateX",
        panY: "translateY",
        projection: am5map.geoMercator(),
        paddingBottom: 0,
        paddingTop: 0,
        paddingLeft: 0,
        paddingRight: 0,
      }),
    );

    // Create main polygon series
    const polygonSeries = chart.series.push(
      am5map.MapPolygonSeries.new(root, {
        geoJSON: am5geodata_worldLow,
        exclude: ["AQ"],
      }),
    );

    polygonSeries.mapPolygons.template.setAll({
      toggleKey: "active",
      interactive: true,
      fill: am5.color(0xeeeeee),
      stroke: am5.color(0xffffff),
      strokeWidth: 1,
      templateField: "polygonSettings",
    });

    polygonSeries.mapPolygons.template.adapters.add("tooltipText", (text, target) => {
      const context = target.dataItem && target.dataItem.dataContext;
      if (context && context.value > 0) {
        return "{name}: " + context.value + " Employees";
      }
      return "{name}";
    });

    // Get colors from CSS variables
    const primaryStr = getComputedStyle(this.nationalityChartRef.el).getPropertyValue('--primary').trim() || "#3061af";
    const darkStr = getComputedStyle(this.nationalityChartRef.el).getPropertyValue('--hr-dark').trim() || "#1a3a6d";
    
    const primaryColor = am5.color(primaryStr);
    const darkColor = am5.color(darkStr);

    polygonSeries.mapPolygons.template.states.create("hover", {
      fillOpacity: 1,
      strokeWidth: 2,
    });

    polygonSeries.mapPolygons.template.states.create("active", {
      fillOpacity: 1,
      stroke: am5.color(0xffffff),
      strokeWidth: 2,
    });

    let previousPolygon;
    polygonSeries.mapPolygons.template.on("active", function (active, target) {
      if (previousPolygon && previousPolygon != target) {
        previousPolygon.set("active", false);
      }
      if (target.get("active")) {
        polygonSeries.zoomToDataItem(target.dataItem);
      } else {
        chart.goHome();
      }
      previousPolygon = target;
    });

    // Add zoom control
    const zoomControl = chart.set(
      "zoomControl",
      am5map.ZoomControl.new(root, {}),
    );
    zoomControl.homeButton.set("visible", true);

    zoomControl.homeButton.get("background").setAll({
      fill: primaryColor,
      fillOpacity: 0.8,
    });
    zoomControl.plusButton.get("background").setAll({
      fill: primaryColor,
      fillOpacity: 0.8,
    });
    zoomControl.minusButton.get("background").setAll({
      fill: primaryColor,
      fillOpacity: 0.8,
    });

    [zoomControl.plusButton, zoomControl.minusButton, zoomControl.homeButton].forEach(btn => {
      btn.get("background").states.create("hover", {
        fill: darkColor,
        fillOpacity: 0.9
      });
      btn.get("background").states.create("down", {
        fill: darkColor,
        fillOpacity: 1
      });
    });

    chart.chartContainer.get("background").events.on("click", function () {
      chart.goHome();
    });

    polygonSeries.mapPolygons.template.events.on("click", (ev) => {
      const context = ev.target.dataItem?.dataContext;
      if (context && context.country_id && context.value > 0) {
        this._openNationalityEmployees(context.country_id, context.name);
      }
    });

    const multiColors = [
      am5.color(0x3061af),
      am5.color(0x118c42),
      am5.color(0xd42a46),
      am5.color(0xc48a17),
      am5.color(0x34a4ca),
      am5.color(0x714b67),
      am5.color(0xe97300),
      am5.color(0x17b355),
      am5.color(0x3498db),
      am5.color(0x9b59b6),
    ];

    const dataMap = stats.map((s, idx) => ({
      id: (s.code || "").toUpperCase(),
      country_id: s.id,
      name: formatTranslatedField(s.name),
      value: s.count,
      polygonSettings: {
        fill: multiColors[idx % multiColors.length],
        fillOpacity: Math.min(0.4 + (s.count) / 10, 1),
      },
    }));

    polygonSeries.data.setAll(dataMap);

    chart.appear(1000, 100);
  }

  _renderNationalityDoughnut(ctx, stats) {
    const labels = stats.map((s) => formatTranslatedField(s.name));
    const dataValues = stats.map((s) => s.count);
    const colors = [
      "rgba(196, 138, 23, 0.85)",
      "rgba(17, 140, 66, 0.85)",
      "rgba(48, 97, 175, 0.85)",
      "rgba(52, 164, 202, 0.85)",
      "rgba(212, 42, 70, 0.85)",
    ];

    this.nationalityChart = new window.Chart(ctx, {
      type: "doughnut",
      data: {
        labels: labels,
        datasets: [
          { data: dataValues, backgroundColor: colors, borderWidth: 2 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "70%",
        onClick: (ev, elements) => {
          if (elements.length > 0) {
            const index = elements[0].index;
            const nat = stats[index];
            if (nat && nat.id) {
              this._openNationalityEmployees(
                nat.id,
                formatTranslatedField(nat.name)
              );
            }
          }
        },
        onHover: (ev, elements) => {
          ev.native.target.style.cursor =
            elements.length > 0 ? "pointer" : "default";
        },
        plugins: { legend: { display: true, position: "bottom" } },
      },
    });
  }

  _switchNationalityView(view) {
    this.state.nationalityView = view;
  }

  _switchPeriod(period) {
    this.state.graphPeriod = period;
  }

  get hasAttendanceData() {
    const dataKey =
      this.state.graphPeriod === "week" ? "last_7_days" : "last_30_days";
    const stats = this.state.attendanceStats[dataKey] || [];
    return stats.some((s) => s.attendance_count > 0 || s.leave_count > 0);
  }

  get totalLeavePages() {
    return Math.ceil(this.state.pendingLeaves / this.state.pageSize) || 1;
  }

  get totalAttendancePages() {
    return Math.ceil(this.state.totalAttendance / this.state.pageSize) || 1;
  }

  get totalAllocationPages() {
    return Math.ceil(this.state.pendingAllocations / this.state.pageSize) || 1;
  }

  get totalLocationPages() {
    return (
      Math.ceil(this.state.totalLocationEmployees / this.state.pageSize) || 1
    );
  }

  async _changePage(listType, newPage) {
    if (listType === "leave") {
      this.state.leavePage = newPage;
    } else if (listType === "attendance") {
      this.state.attendancePage = newPage;
    } else if (listType === "allocation") {
      this.state.allocationPage = newPage;
    } else if (listType === "location") {
      this.state.locationPage = newPage;
    }
    await this._loadDashboardData(listType);
  }

  _openEmployeeList() {
    this.env.services.action.doAction({
      res_model: "hr.employee",
      name: "Employees",
      views: [
        [false, "list"],
        [false, "form"],
      ],
      type: "ir.actions.act_window",
      view_mode: "list,form",
      target: "current",
    });
  }

  _openDepatmentEmployees(deptId, deptName) {
    this.env.services.action.doAction({
      res_model: "hr.employee",
      name: `Employees: ${deptName}`,
      views: [
        [false, "list"],
        [false, "form"],
      ],
      type: "ir.actions.act_window",
      view_mode: "list,form",
      target: "current",
      domain: [["department_id", "=", deptId]],
    });
  }

  _openGenderEmployees(genderValue, genderLabel) {
    this.env.services.action.doAction({
      res_model: "hr.employee",
      name: `Employees: ${genderLabel}`,
      views: [
        [false, "list"],
        [false, "form"],
      ],
      type: "ir.actions.act_window",
      view_mode: "list,form",
      target: "current",
      domain: [["sex", "=", genderValue]],
    });
  }

  _openNationalityEmployees(countryId, countryName) {
    this.env.services.action.doAction({
      res_model: "hr.employee",
      name: `Employees: ${countryName}`,
      views: [
        [false, "list"],
        [false, "form"],
      ],
      type: "ir.actions.act_window",
      view_mode: "list,form",
      target: "current",
      domain: [["country_id", "=", countryId]],
    });
  }

  _openAttendanceList() {
    const today = new Date().toISOString().split("T")[0];
    this.env.services.action.doAction({
      res_model: "hr.attendance",
      name: "Attendance",
      views: [
        [false, "list"],
        [false, "form"],
      ],
      type: "ir.actions.act_window",
      view_mode: "list,form",
      target: "current",
      domain: [
        "|",
        ["check_in", ">=", today + " 00:00:00"],
        ["check_out", ">=", today + " 00:00:00"],
      ],
    });
  }

  _openLeaveList(status) {
    const today = new Date().toISOString().split("T")[0];
    let domain = [["state", "=", status]];

    if (status === "on_leave") {
      domain = [
        ["state", "=", "validate"],
        ["date_from", "<=", today + " 23:59:59"],
        ["date_to", ">=", today + " 00:00:00"],
      ];
    }

    this.env.services.action.doAction({
      res_model: "hr.leave",
      name: status === "on_leave" ? "On Leave" : "Leave Requests",
      views: [
        [false, "list"],
        [false, "form"],
      ],
      type: "ir.actions.act_window",
      view_mode: "list,form",
      target: "current",
      domain: domain,
    });
  }

  _openAllocationList() {
    this.env.services.action.doAction({
      res_model: "hr.leave.allocation",
      name: "Allocations",
      views: [
        [false, "list"],
        [false, "form"],
      ],
      type: "ir.actions.act_window",
      view_mode: "list,form",
      target: "current",
      domain: [["state", "in", ["confirm", "validate1"]]],
    });
  }

  _openLeaveRequest(id, employeeName) {
    this.env.services.action.doAction(
      {
        res_model: "hr.leave",
        name: `Leave Request of ${employeeName}`,
        res_id: id,
        views: [[false, "form"]],
        type: "ir.actions.act_window",
        view_mode: "form",
        target: "new",
      },
      {
        onClose: () => {
          this._loadDashboardData();
        },
      },
    );
  }

  _openAllocationRequest(id, employeeName) {
    this.env.services.action.doAction(
      {
        res_model: "hr.leave.allocation",
        name: `Allocation Request of ${employeeName}`,
        res_id: id,
        views: [[false, "form"]],
        type: "ir.actions.act_window",
        view_mode: "form",
        target: "new",
      },
      {
        onClose: () => {
          this._loadDashboardData();
        },
      },
    );
  }

  _openAttendance(id, employeeName) {
    this.env.services.action.doAction(
      {
        res_model: "hr.attendance",
        name: `Attendance of ${employeeName}`,
        res_id: id,
        views: [[false, "form"]],
        type: "ir.actions.act_window",
        view_mode: "form",
        target: "new",
      },
      {
        onClose: () => {
          this._loadDashboardData();
        },
      },
    );
  }

  _openEmployee(id, name) {
    this.env.services.action.doAction({
      res_model: "hr.employee",
      name: name,
      res_id: id,
      views: [[false, "form"]],
      type: "ir.actions.act_window",
      view_mode: "form",
      target: "current",
    });
  }

  async selectLocation(locationId) {
    this.state.selectedLocationId = locationId;
    this.state.locationPage = 1;
    await this._loadDashboardData("location");
  }

  _openRecruitment(jobId = null) {
    const action = {
      res_model: "hr.job",
      name: "Job Positions",
      views: [
        [false, "list"],
        [false, "form"],
      ],
      type: "ir.actions.act_window",
      view_mode: "list,form",
      target: "current",
    };
    if (jobId) {
      action.res_id = jobId;
      action.view_mode = "form";
      action.views = [[false, "form"]];
    }
    this.env.services.action.doAction(action);
  }
}

registry
  .category("actions")
  .add("wyn_hr_dashboard.action_hr_dashboard", HrDashboard);
