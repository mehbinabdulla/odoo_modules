# -*- coding: utf-8 -*-
{
    'name': 'HR Dashboard',
    'version': '19.0.1.0.0',
    'summary': 'Modern HR Analytics Dashboard for Odoo CE',
    'description': """
HR Dashboard provides a comprehensive, modern analytics dashboard for Human Resources
in Odoo Community Edition. Get real-time insights on employees, attendance,
leaves, payroll, and more — all in a clean, professional interface.
""",
    'sequence': 10,
    'category': 'Human Resources/Dashboard',
    'depends': ['base', 'web', 'hr', 'hr_attendance', 'hr_holidays'],
    'author': 'Wyn Interactive Ltd.',
    'website': 'https://wyninteractive.odoo.com',

    'data': [
        'views/hr_views.xml',
    ],

    'assets': {
        'web.assets_backend': [
            'wyn_hr_dashboard/static/src/scss/dashboard.scss',
            'wyn_hr_dashboard/static/src/xml/dashboard.xml',
            'wyn_hr_dashboard/static/src/xml/pagination.xml',
            'wyn_hr_dashboard/static/src/xml/location_dropdown.xml',
            'wyn_hr_dashboard/static/src/js/dashboard.js',
            'wyn_hr_dashboard/static/src/js/pagination.js',
            'wyn_hr_dashboard/static/src/js/location_dropdown.js',
        ],
    },

    'images': [
        'static/description/banner.jpg',
        'static/description/dashboard_screenshot.jpg',
    ],

    'license': 'OPL-1',
    'application': False,
    'installable': True,
    'auto_install': True,
    'price': 9.99,
    'currency': 'USD',
}
