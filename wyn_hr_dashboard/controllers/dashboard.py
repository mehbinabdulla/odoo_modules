# -*- coding: utf-8 -*-
from odoo import http
from odoo.http import request, Response
import json


class HrDashboardController(http.Controller):
    """
    Single endpoint that runs all dashboard queries as raw SQL in one
    database round-trip and returns a JSON payload.

    Raw SQL is used intentionally over ORM calls to:
      - Avoid Python-level mapping overhead for large datasets
      - Execute multiple aggregates in a single query where possible
      - Reduce total latency for the initial dashboard load
    """

    @http.route(
        "/wyn_hr_dashboard/dashboard_data",
        type="http",
        auth="user",
        methods=["GET"],
        csrf=False,
    )
    def dashboard_data(self, **kwargs):
        leave_limit = int(kwargs.get('leave_limit', 5))
        leave_offset = int(kwargs.get('leave_offset', 0))
        attendance_limit = int(kwargs.get('attendance_limit', 5))
        attendance_offset = int(kwargs.get('attendance_offset', 0))
        allocation_limit = int(kwargs.get('allocation_limit', 5))
        allocation_offset = int(kwargs.get('allocation_offset', 0))

        location_limit = int(kwargs.get('location_limit', 5))
        location_offset = int(kwargs.get('location_offset', 0))
        location_id = kwargs.get('location_id')
        if location_id and location_id != 'all':
            location_id = int(location_id)
        else:
            location_id = 'all'

        currentEmployee= ""
        cr = request.env.cr

        # ── 1. KPI counters (single query) ──────────────────────────────────
        cr.execute("""
            SELECT
                -- Total active employees
                (
                    SELECT COUNT(*)
                    FROM hr_employee
                    WHERE active = TRUE
                      AND company_id = %(company_id)s
                ) AS total_employees,

                -- Employees with an approved leave covering today
                (
                    SELECT COUNT(DISTINCT employee_id)
                    FROM hr_leave
                    WHERE state = 'validate'
                      AND date_from::date <= CURRENT_DATE
                      AND date_to::date   >= CURRENT_DATE
                ) AS on_leave,

                -- Pending leave requests (confirm or validate1)
                (
                    SELECT COUNT(*)
                    FROM hr_leave
                    WHERE state IN ('confirm', 'validate1')
                ) AS pending_leaves,

                -- Employees checked in today (attendance rows with check_in or check_out today)
                (
                    SELECT COUNT(DISTINCT employee_id)
                    FROM hr_attendance
                    WHERE check_in::date = CURRENT_DATE OR check_out::date = CURRENT_DATE
                ) AS present_today,

                -- Total attendance records for today (for pagination)
                (
                    SELECT COUNT(*)
                    FROM hr_attendance
                    WHERE check_in::date = CURRENT_DATE OR check_out::date = CURRENT_DATE
                ) AS total_attendance,

                -- Pending allocations
                (
                    SELECT COUNT(*)
                    FROM hr_leave_allocation
                    WHERE state IN ('confirm', 'validate1')
                ) AS pending_allocations,

                -- Total employees for the selected work location
                (
                    SELECT COUNT(e.id)
                    FROM hr_employee e
                    LEFT JOIN hr_version v ON v.id = e.current_version_id
                    WHERE e.active = TRUE
                      AND (v.work_location_id = %(location_id)s OR %(location_id_str)s = 'all')
                ) AS total_location_employees
        """, {
            'company_id': request.env.company.id,
            'location_id': location_id if location_id != 'all' else None,
            'location_id_str': str(location_id)
        })

        kpis = cr.dictfetchone()

        # ── 2. Recent pending leave requests ────────────────────────────────
        cr.execute(f"""
            SELECT
                hl.id,
                emp.id                          AS employee_id,
                emp.name                        AS employee_name,
                hls.name                        AS leave_type,
                hl.date_from::date::text        AS date_from,
                hl.date_to::date::text          AS date_to,
                hl.state
            FROM hr_leave hl
            JOIN hr_employee    emp ON emp.id  = hl.employee_id
            JOIN hr_leave_type  hls ON hls.id  = hl.holiday_status_id
            WHERE hl.state IN ('confirm', 'validate1')
            ORDER BY hl.date_from DESC, hl.id DESC
            LIMIT {leave_limit} OFFSET {leave_offset}
        """)
        leave_rows = cr.dictfetchall()

        # ── 3. Today's attendance ───────────────────────────────────────────
        cr.execute(f"""
            SELECT
                ha.id,
                emp.id                              AS employee_id,
                emp.name                            AS employee_name,
                TO_CHAR(ha.check_in  AT TIME ZONE 'UTC', 'HH24:MI') AS check_in,
                CASE
                    WHEN ha.check_out IS NOT NULL
                    THEN TO_CHAR(ha.check_out AT TIME ZONE 'UTC', 'HH24:MI')
                    ELSE NULL
                END                                  AS check_out,
                ha.worked_hours                      AS worked_hours
            FROM hr_attendance ha
            JOIN hr_employee emp ON emp.id = ha.employee_id
            WHERE ha.check_in::date = CURRENT_DATE OR ha.check_out::date = CURRENT_DATE
            ORDER BY ha.check_in DESC, ha.id DESC
            LIMIT {attendance_limit} OFFSET {attendance_offset}
        """)
        attendance_rows = cr.dictfetchall()

        # ── 4. Pending allocations ──────────────────────────────────────────
        cr.execute(f"""
            SELECT
                hla.id,
                emp.id                          AS employee_id,
                emp.name                        AS employee_name,
                hls.name                        AS leave_type,
                hla.number_of_days              AS duration,
                hla.state
            FROM hr_leave_allocation hla
            JOIN hr_employee    emp ON emp.id  = hla.employee_id
            JOIN hr_leave_type  hls ON hls.id  = hla.holiday_status_id
            WHERE hla.state IN ('confirm', 'validate1')
            ORDER BY hla.id DESC
            LIMIT {allocation_limit} OFFSET {allocation_offset}
        """)
        allocation_rows = cr.dictfetchall()

        # ── 5. Employees by Work Location ──────────────────────────────────
        location_where = "WHERE e.active = TRUE"
        params = {'limit': location_limit, 'offset': location_offset}
        if location_id != 'all':
            location_where += " AND v.work_location_id = %(location_id)s"
            params['location_id'] = location_id

        cr.execute(f"""
            SELECT
                e.id,
                e.name,
                v.job_title,
                wl.name as location_name
            FROM hr_employee e
            LEFT JOIN hr_version v ON v.id = e.current_version_id
            LEFT JOIN hr_work_location wl ON wl.id = v.work_location_id
            {location_where}
            ORDER BY e.name ASC
            LIMIT %(limit)s OFFSET %(offset)s
        """, params)
        location_employee_rows = cr.dictfetchall()

        def _initials(name):
            if not name:
                return '?'
            words = name.strip().split()
            if len(words) == 1:
                return words[0][0].upper()
            return (words[0][0] + words[-1][0]).upper()

        employee_ids = list(set(
            [r['employee_id'] for r in leave_rows] + 
            [r['employee_id'] for r in attendance_rows] +
            [r['employee_id'] for r in allocation_rows] +
            [r['id'] for r in location_employee_rows]
        ))
        
        emp_images = {}
        if employee_ids:
            attachments = request.env['ir.attachment'].sudo().search([
                ('res_model', '=', 'hr.employee'),
                ('res_field', 'in', ['avatar_128', 'image_128', 'image_1920']),
                ('res_id', 'in', employee_ids)
            ])
            for att in attachments:
                if att.res_id not in emp_images and att.datas:
                    emp_images[att.res_id] = f"data:{att.mimetype or 'image/png'};base64,{att.datas.decode('utf-8')}"

        # ── 6. Recruitment (if installed) ──────────────────────────────────
        recruitment_enabled = request.env['ir.module.module'].sudo().search_count([
            ('name', '=', 'hr_recruitment'),
            ('state', '=', 'installed')
        ]) > 0

        total_recruiting_apps = 0
        job_positions = []
        if recruitment_enabled:
            # SQL is lighter than ORM for these counts as it avoids object instantiation and caching overhead
            cr.execute("""
                SELECT COUNT(*) 
                FROM hr_applicant a
                JOIN hr_job j ON j.id = a.job_id
                LEFT JOIN hr_recruitment_stage s ON s.id = a.stage_id
                WHERE a.active = TRUE 
                  AND a.refuse_reason_id IS NULL 
                  AND (s.hired_stage IS NULL OR s.hired_stage = FALSE)
                  AND j.active = TRUE
                  AND j.no_of_recruitment > 0
            """)
            total_recruiting_apps = cr.fetchone()[0] or 0

            cr.execute("""
                SELECT 
                    j.id,
                    j.name,
                    j.no_of_recruitment as target,
                    (
                        SELECT COUNT(*) 
                        FROM hr_applicant a
                        LEFT JOIN hr_recruitment_stage s ON s.id = a.stage_id
                        WHERE a.job_id = j.id 
                          AND a.active = TRUE 
                          AND a.refuse_reason_id IS NULL 
                          AND (s.hired_stage IS NULL OR s.hired_stage = FALSE)
                    ) as app_count
                FROM hr_job j
                WHERE j.active = TRUE AND j.no_of_recruitment > 0
                ORDER BY app_count DESC, j.id DESC
                LIMIT 5
            """)
            job_positions = cr.dictfetchall()

        payload = {
            'kpis': {
                'total_employees': kpis['total_employees'],
                'on_leave':        kpis['on_leave'],
                'pending_leaves':  kpis['pending_leaves'],
                'present_today':   kpis['present_today'],
                'total_attendance': kpis['total_attendance'],
                'pending_allocations': kpis['pending_allocations'],
                'total_location_employees': kpis['total_location_employees'],
                'total_recruiting_apps': total_recruiting_apps,
            },
            'recruitment_enabled': recruitment_enabled,
            'job_positions': job_positions,
            'leave_requests': [
                {
                    'id':          r['id'],
                    'employee':    r['employee_name'],
                    'employeeImg': emp_images.get(r['employee_id']),
                    'initials':    _initials(r['employee_name']),
                    'type':        r['leave_type'],
                    'dates':       f"{r['date_from']} → {r['date_to']}",
                    'state':       'leave' if r['state'] == 'confirm' else 'approved',
                    'state_label': 'To Approve' if r['state'] == 'confirm' else 'Validated',
                }
                for r in leave_rows
            ],
            'attendance': [
                {
                    'id':           r['id'],
                    'employee':     r['employee_name'],
                    'employeeImg':  emp_images.get(r['employee_id']),
                    'initials':     _initials(r['employee_name']),
                    'check_in':     r['check_in'],
                    'check_out':    r['check_out'] or '',
                    'worked_hours': r['worked_hours'],
                    'status':       'present' if r['check_out'] else 'absent',
                    'status_label': 'Checked Out' if r['check_out'] else 'Checked In',
                }
                for r in attendance_rows
            ],
            'allocations': [
                {
                    'id':          r['id'],
                    'employee':    r['employee_name'],
                    'employeeImg': emp_images.get(r['employee_id']),
                    'initials':    _initials(r['employee_name']),
                    'type':        r['leave_type'],
                    'duration':    r['duration'],
                    'state':       'leave' if r['state'] == 'confirm' else 'approved',
                    'state_label': 'To Approve' if r['state'] == 'confirm' else 'Validated',
                }
                for r in allocation_rows
            ],
            'location_employees': [
                {
                    'id':          r['id'],
                    'name':        r['name'],
                    'job_title':   r['job_title'],
                    'location':    r['location_name'] or 'Not Specified',
                    'employeeImg': emp_images.get(r['id']),
                    'initials':    _initials(r['name']),
                }
                for r in location_employee_rows
            ],
            'attendance_stats': {
                'last_7_days': self._get_attendance_stats(cr, 7),
                'last_30_days': self._get_attendance_stats(cr, 30),
            },
            'dept_distribution': self._get_dept_distribution(cr),
            'gender_distribution': self._get_gender_distribution(cr),
            'nationality_distribution': self._get_nationality_distribution(cr),
            'work_locations': self._get_work_locations(cr),
        }

        return Response(
            json.dumps(payload),
            content_type='application/json',
            status=200,
        )

    def _get_dept_distribution(self, cr):
        cr.execute("""
            SELECT 
                d.id,
                d.name,
                COUNT(e.id) as count
            FROM hr_department d
            LEFT JOIN hr_version v ON v.department_id = d.id
            LEFT JOIN hr_employee e ON e.current_version_id = v.id AND e.active = TRUE
            WHERE d.active = TRUE
            GROUP BY d.id, d.name
            HAVING COUNT(e.id) > 0
            ORDER BY count DESC
        """)
        return cr.dictfetchall()

    def _get_gender_distribution(self, cr):
        cr.execute("""
            SELECT 
                v.sex as name,
                COUNT(e.id) as count
            FROM hr_employee e
            JOIN hr_version v ON v.id = e.current_version_id
            WHERE e.active = TRUE
              AND v.sex IS NOT NULL
            GROUP BY v.sex
            ORDER BY count DESC
        """)
        return cr.dictfetchall()

    def _get_nationality_distribution(self, cr):
        cr.execute("""
            SELECT 
                c.id,
                c.name as name,
                c.code as code,
                COUNT(e.id) as count
            FROM hr_employee e
            JOIN hr_version v ON v.id = e.current_version_id
            JOIN res_country c ON c.id = v.country_id
            WHERE e.active = TRUE
            GROUP BY c.id, c.name, c.code
            ORDER BY count DESC
        """)
        return cr.dictfetchall()

    def _get_attendance_stats(self, cr, days):
        cr.execute(f"""
            SELECT 
                TO_CHAR(d::date, 'DD Mon') as day,
                TO_CHAR(d::date, 'DD Mon YYYY, FMDay') as full_day,
                (SELECT COUNT(DISTINCT employee_id) 
                 FROM hr_attendance 
                 WHERE check_in::date = d::date OR (check_out IS NOT NULL AND check_out::date = d::date)) as attendance_count,
                (SELECT COUNT(DISTINCT employee_id)
                 FROM hr_leave
                 WHERE state = 'validate'
                   AND date_from::date <= d::date
                   AND date_to::date >= d::date) as leave_count
            FROM generate_series(CURRENT_DATE - INTERVAL '{days - 1} days', CURRENT_DATE, '1 day') d
            ORDER BY d ASC
        """)
        return cr.dictfetchall()

    def _get_work_locations(self, cr):
        cr.execute("""
            SELECT 
                wl.id,
                wl.name,
                COUNT(e.id) as count
            FROM hr_work_location wl
            JOIN hr_version v ON v.work_location_id = wl.id
            JOIN hr_employee e ON e.current_version_id = v.id AND e.active = TRUE
            GROUP BY wl.id, wl.name
            ORDER BY count DESC
        """)
        return cr.dictfetchall()
