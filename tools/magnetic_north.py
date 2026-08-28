"""Magnetic north calculations for Swedish map workspaces."""
from __future__ import annotations

import datetime

from pyproj import Proj
from wmm import wmm_calc

MODEL_NAME = 'WMM2025'
MODEL_START = datetime.date(2025, 1, 1)
MODEL_END = datetime.date(2029, 12, 31)
SWEREF_99_TM = Proj('EPSG:3006')


def parse_date(value=None):
    if value in (None, ''):
        return datetime.datetime.now(datetime.timezone.utc).date()
    try:
        result = datetime.date.fromisoformat(str(value))
    except ValueError as exc:
        raise ValueError('Datum ska anges som ÅÅÅÅ-MM-DD') from exc
    if not MODEL_START <= result <= MODEL_END:
        raise ValueError(f'{MODEL_NAME} gäller {MODEL_START.isoformat()}–{MODEL_END.isoformat()}')
    return result


def calculate_magnetic_north(latitude, longitude, date=None):
    latitude = float(latitude); longitude = float(longitude)
    if not -90 <= latitude <= 90 or not -180 <= longitude <= 180:
        raise ValueError('Koordinaten ligger utanför giltigt intervall')
    calculation_date = parse_date(date)
    model = wmm_calc()
    model.setup_time([calculation_date.year], [calculation_date.month], [calculation_date.day])
    model.setup_env([latitude], [longitude], [0.0])
    declination = float(model.get_Bdec()[0])
    convergence = float(SWEREF_99_TM.get_factors(longitude, latitude).meridian_convergence)
    return {
        'model': MODEL_NAME,
        'date': calculation_date.isoformat(),
        'latitude': round(latitude, 7),
        'longitude': round(longitude, 7),
        'declinationDegrees': round(declination, 4),
        'meridianConvergenceDegrees': round(convergence, 4),
        'gridToMagneticDegrees': round(declination - convergence, 4),
        'projection': 'SWEREF 99 TM (EPSG:3006)',
        'localVariationWarning': True,
    }
