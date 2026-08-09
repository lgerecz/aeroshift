import re
import traceback
import os
import json
import base64
import sys
import io
import contextlib
from fastapi import FastAPI, HTTPException, Header, Body, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict, Any, Optional
from ortools.sat.python import cp_model

app = FastAPI(
    title="AeroShift Backend",
    description="Backend de Optimización (OR-Tools) y Visión IA para AeroShift - Versión Azul Handling",
    version="1.0.0"
)

# Enable CORS for frontend communication
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Permits all origins for easy development/testing
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 1. ZONAS (FROM YOUR COLAB CODE)
SCHENGEN = {
    'FRA','MUC','BER','DUS','HAM','STR','CGN','NUE','HAJ','BRE','FMO','NRN',
    'CDG','ORY','LYS','NCE','MRS','TLS','BOD','NTE','LIL','BVA',
    'FCO','MXP','LIN','VCE','NAP','BGY','PSA','CIA','TRN','BLQ','PMO','CAG','BRI','TSF',
    'AMS','EIN','RTM','BRU','CRL','LIS','OPO','FAO',
    'ATH','SKG','HER','RHO','CFU','JMK','ZTH','KGS','CHQ',
    'ARN','GOT','MMX','VST','OSL','BGO','SVG','TRD',
    'CPH','BLL','AAL','AAR','HEL','TMP','TKU','OUL',
    'VIE','GRZ','INN','SZG','LNZ','PRG','BRQ','OSR',
    'WAW','KRK','GDN','WRO','KTW','POZ','LCJ','RZE','WMI',
    'BUD','OTP','CLJ','TSR','IAS','BTS','LJU',
    'ZAG','SPU','DBV','PUL','ZAD','RJK','SOF','VAR','BOJ',
    'LUX','ZRH','GVA','BSL','KEF','MLA','TLL','RIX','VNO',
    'MAD','BCN','PMI','VLC','SVQ','AGP','BIO','SDR','ZAZ',
    'TFN','TFS','LPA','ACE','FUE','VDE','SPC','GMZ','MLN','IBZ','MAH',
}

NON_SCHENGEN = {
    'LHR','LGW','LCY','STN','LTN','MAN','BHX','EDI','GLA',
    'BRS','NCL','LPL','EMA','SOU','ABZ','BFS','PIK','LBA','CWL','BHD','MME','BOH',
    'DUB','ORK','SNN','NOC','KIR',
    'CMN','RAK','AGA','TNG','FEZ','RBA','OZZ','NDR','SFI',
    'IST','SAW','AYT','ADB','ESB','GZT','DLM','BJV',
    'TUN','MIR','SFA','DJE','CAI','HRG','SSH','LXR',
    'ALG','ORN','CZL','AAE','TLM','BJA','GJL',
    'DKR','SID','RAI','BVC','VXE',
    'TLV','DXB','AUH','SHJ','DOH','KWI','RUH','JED',
    'JFK','LAX','MIA','ORD','ATL','DFW','SFO','BOS',
    'MEX','CUN','SDQ','PUJ','HAV','BOG','MDE','CCS','LIM','GRU','GIG','EZE','SCL',
    'BEG','TIA','PRN','TGD','TIV','SJJ','TBS','EVN','KIV',
}

def get_zona(iata: str) -> str:
    c = iata.upper().strip()
    if c in SCHENGEN:
        return 'S'
    return 'NS'

def gap_minimo(za: str, zb: str) -> int:
    return 60 if za == zb else 75

def gap_tolerancia(za: str, zb: str) -> int:
    return 55 if za == zb else 70

PUERTAS_REMOTAS = {'B20','B22','C32','C36','C39','C40'}
ROLES_NO_EMBARCAN = {'DSM','PSM','OPS','TKT','TKD','LL','SOMBRA','SHADOW','FAMI','SICK','CURSO','AUTOCHECKIN'}
ROLES_OPERATIVOS = {'TKT','LL','OPS'}

# Helper time functions
def hms(t: str) -> int:
    try:
        h, m = map(int, t.split(':'))
        return h * 60 + m
    except Exception:
        return 0

def t2m_fin(ini_s: str, fin_s: str) -> int:
    i = hms(ini_s)
    f = hms(fin_s)
    if f == 0 or f < i:
        f += 1440
    return f

def m2t(m: int) -> str:
    m = m % 1440
    return f"{m//60:02d}:{m%60:02d}"

def dur_str(m: int) -> str:
    return f"{m//60}h {m%60:02d}min"

def hor_turno_completo(ag: dict) -> str:
    txt = f"{ag['inicio']}–{ag['fin']}"
    if ag.get('bloque2'):
        txt += f" / {ag['bloque2']['inicio']}–{ag['bloque2']['fin']}"
    txt += f" / {dur_str(ag['_jornada'])}"
    return txt

def ndisp(ag: dict) -> str:
    if ag['rol'] in ROLES_OPERATIVOS:
        return f"{ag['nombre']} [{ag['rol']}]"
    if ag['espec']:
        return f"{ag['nombre']} [{'/'.join(ag['espec'])}]"
    return ag['nombre']

def icono_break(mins: int) -> str:
    if mins >= 70:
        return "✅"
    if mins >= 55:
        return "⏳"
    return ""

def vkey(v: dict) -> str:
    return f"{v['codigo']}_{v['num']}"

# Pydantic Schemas for API
class AgentInput(BaseModel):
    id: int
    name: str
    inicio: str
    fin: str
    rol: str
    espec: List[str] = []
    excluir: bool = False
    excluir_embarque: bool = False
    bloque2: Optional[Dict[str, str]] = None

class FlightInput(BaseModel):
    id: int
    destination: str
    number: str
    time: str              # departure time (STD)
    gate: Optional[str] = ""
    pax: Optional[int] = 186
    charter: Optional[bool] = False
    manual: Optional[bool] = False

class OptimizeRequest(BaseModel):
    agents: List[AgentInput]
    flights: List[FlightInput]
    modo: Optional[str] = 'PROPORCIONAL' # 'EQUILIBRADO' | 'PROPORCIONAL'

@app.post("/optimize")
def optimize_schedule(req: OptimizeRequest):
    """
    Usa Google OR-Tools (CP-SAT Solver) para resolver la asignación óptima de agentes a vuelos
    siguiendo estrictamente el modelo matemático y generando los 5 reportes de tu script de Google Colab.
    """
    agents_input = req.agents
    flights_input = req.flights
    MODO = req.modo or 'PROPORCIONAL'
    
    if not agents_input:
        raise HTTPException(status_code=400, detail="No hay agentes disponibles para optimizar.")
    if not flights_input:
        raise HTTPException(status_code=400, detail="No hay vuelos para asignar.")

    # 1. PREPROCESAMIENTO (FROM COLAB SECTION 6)
    AGENTES = []
    for ag in agents_input:
        ag_dict = {
            'id': ag.id,
            'nombre': ag.name,
            'inicio': ag.inicio,
            'fin': ag.fin,
            'rol': ag.rol,
            'espec': ag.espec,
            'excluir': ag.excluir,
            'excluir_embarque': ag.excluir_embarque,
            'bloque2': ag.bloque2
        }
        # Time processing
        ag_dict['_t_ini'] = hms(ag.inicio)
        if ag.bloque2:
            ag_dict['_pausa_ini'] = t2m_fin(ag.inicio, ag.fin)
            b2i = hms(ag.bloque2['inicio'])
            b2f = hms(ag.bloque2['fin'])
            if b2i < ag_dict['_pausa_ini'] % 1440:
                b2i += 1440
            if b2f < b2i:
                b2f += 1440
            ag_dict['_pausa_fin'] = b2i
            ag_dict['_t_fin'] = b2f
            ag_dict['_jornada'] = (ag_dict['_pausa_ini'] - ag_dict['_t_ini']) + (ag_dict['_t_fin'] - ag_dict['_pausa_fin'])
        else:
            ag_dict['_pausa_ini'] = ag_dict['_pausa_fin'] = None
            ag_dict['_t_fin'] = t2m_fin(ag.inicio, ag.fin)
            ag_dict['_jornada'] = ag_dict['_t_fin'] - ag_dict['_t_ini']
        
        ag_dict['_midpoint'] = ag_dict['_t_ini'] + ag_dict['_jornada'] // 2
        AGENTES.append(ag_dict)

    # Filter pools
    activos = [a for a in AGENTES if not a['excluir'] and not a.get('excluir_embarque') and a['rol'] not in ROLES_NO_EMBARCAN]
    cobertura_pool = [a for a in AGENTES if not a['excluir'] and a['espec']]
    activos_idx = {ag['nombre']: ai for ai, ag in enumerate(activos)}
    solo_cobertura = [a for a in AGENTES if a.get('excluir_embarque') and not a['excluir'] and a['rol'] not in ROLES_NO_EMBARCAN]
    todos_csa = activos + solo_cobertura

    # Process flights
    VUELOS = []
    for idx, v in enumerate(flights_input):
        std = hms(v.time)
        v_dict = {
            'num': idx + 1,
            'id': v.id,
            'codigo': v.number,
            'destino': v.destination,
            'std': v.time,
            'puerta': v.gate,
            'pax': v.pax or 186,
            'charter': v.charter,
            'manual': v.manual,
            'emb_inicio': std - 40,
            'emb_fin': std - 15,
            'std_min': std,
            'zona': get_zona(v.destination),
            'agentes_req': 3 if v.gate in PUERTAS_REMOTAS else 2,
            'pax_unico_ok': (v.pax or 186) <= 100
        }
        VUELOS.append(v_dict)

    VUELOS_ORD = sorted(VUELOS, key=lambda v: v['std_min'])
    SPLIT = 660

    # 2. MODELO CP-SAT (FROM COLAB SECTION 7)
    model = cp_model.CpModel()
    solver = cp_model.CpSolver()
    
    A, V = len(activos), len(VUELOS)
    if A == 0 or V == 0:
        raise HTTPException(status_code=400, detail="No hay suficientes agentes activos o vuelos para realizar el cálculo.")

    x = [[model.NewBoolVar(f'x_{a}_{v}') for v in range(V)] for a in range(A)]
    TOL_ENT, TOL_SAL = 10, 5

    # Constraint: Flight agents requirement
    for vi, v in enumerate(VUELOS):
        total = sum(x[ai][vi] for ai in range(A))
        if v['pax_unico_ok']:
            model.Add(total >= 1)
            model.Add(total <= v['agentes_req'])
        else:
            model.Add(total == v['agentes_req'])

    # Constraint: Availability bounds & double blocks
    for ai, ag in enumerate(activos):
        disp_desde = ag['_t_ini'] + 30 - TOL_ENT
        for vi, v in enumerate(VUELOS):
            disp_hasta = ag['_t_fin'] + TOL_SAL - 15
            if v['emb_inicio'] < disp_desde or v['std_min'] > disp_hasta:
                model.Add(x[ai][vi] == 0)
                continue
            if ag['_pausa_ini'] is not None:
                if v['emb_inicio'] < ag['_pausa_fin'] and v['emb_fin'] > ag['_pausa_ini']:
                    model.Add(x[ai][vi] == 0)
                    continue
                if v['emb_inicio'] < ag['_pausa_ini'] and v['std_min'] > ag['_pausa_ini'] + TOL_SAL:
                    model.Add(x[ai][vi] == 0)

    # Constraint: No overlapping flights (simultaneous flights)
    for ai in range(A):
        for vi in range(V):
            for vj in range(vi+1, V):
                va, vb = VUELOS[vi], VUELOS[vj]
                if va['emb_inicio'] < vb['emb_fin'] and vb['emb_inicio'] < va['emb_fin']:
                    model.Add(x[ai][vi] + x[ai][vj] <= 1)

    # Constraint: Gap times (same-zone / different-zone separation)
    for ai in range(A):
        for vi in range(V):
            for vj in range(V):
                if vi == vj:
                    continue
                va, vb = VUELOS[vi], VUELOS[vj]
                if vb['emb_inicio'] <= va['emb_inicio']:
                    continue
                if vb['emb_inicio'] - va['emb_inicio'] < gap_tolerancia(va['zona'], vb['zona']):
                    model.Add(x[ai][vi] + x[ai][vj] <= 1)

    # Optional flight interval variables for breaks/coverage
    flight_iv_dict = {}
    for ai, ag in enumerate(activos):
        if ag['_jornada'] > 360 or ag['espec']:
            flight_iv_dict[ai] = [
                model.NewOptionalIntervalVar(
                    v['emb_inicio'], 
                    v['std_min'] - v['emb_inicio'], 
                    v['std_min'], 
                    x[ai][vi], 
                    f'fi_{ai}_{vi}'
                ) for vi, v in enumerate(VUELOS)
            ]

    # Constraint: Lunch Breaks
    break_iv_dict = {}
    for ai, ag in enumerate(activos):
        if ag['_jornada'] > 360:
            mid = ag['_midpoint']
            hi = max(mid, ag['_t_fin'] - 70)
            brk_s = model.NewIntVar(mid, hi, f'bs_{ai}')
            brk_e = model.NewIntVar(mid+70, ag['_t_fin'], f'be_{ai}')
            brk_iv = model.NewIntervalVar(brk_s, 70, brk_e, f'bi_{ai}')
            break_iv_dict[ai] = brk_iv
            model.AddNoOverlap([brk_iv] + flight_iv_dict[ai])

    # Constraint: Department Coverage (TKT, LL, OPS)
    for op_idx, op_ag in enumerate(AGENTES):
        if op_ag['rol'] not in ROLES_OPERATIVOS or op_ag['excluir'] or op_ag['_jornada'] <= 360:
            continue
        dept = op_ag['rol']
        op_mid = op_ag['_midpoint']
        op_fin = op_ag['_t_fin']
        if op_fin - op_mid < 70:
            continue
        
        can_cover = []
        for cov_ag in cobertura_pool:
            if dept not in cov_ag['espec']:
                continue
            if cov_ag['_t_fin'] <= op_mid or cov_ag['_t_ini'] >= op_fin:
                continue
            cov_from = max(op_mid, cov_ag['_t_ini'])
            cov_to = min(op_fin, cov_ag['_t_fin'])
            if cov_to - cov_from < 70:
                continue
            
            is_cov = model.NewBoolVar(f'cov_{cov_ag["nombre"]}_{op_idx}')
            cov_s = model.NewIntVar(cov_from, cov_to-70, f'cs_{cov_ag["nombre"]}_{op_idx}')
            cov_e = model.NewIntVar(cov_from+70, cov_to, f'ce_{cov_ag["nombre"]}_{op_idx}')
            cov_iv = model.NewOptionalIntervalVar(cov_s, 70, cov_e, is_cov, f'civ_{cov_ag["nombre"]}_{op_idx}')
            
            no_ov = [cov_iv]
            ai = activos_idx.get(cov_ag['nombre'])
            if ai is not None:
                if ai in flight_iv_dict:
                    no_ov += flight_iv_dict[ai]
                if ai in break_iv_dict:
                    no_ov.append(break_iv_dict[ai])
            
            model.AddNoOverlap(no_ov)
            can_cover.append(is_cov)
        
        if can_cover:
            model.Add(sum(can_cover) >= 1)

    # Workload optimization objective
    carga_ag = [sum(x[ai][vi] for vi in range(V)) for ai in range(A)]
    for ai in range(A):
        for aj in range(A):
            if ai != aj and activos[ai]['_jornada'] > activos[aj]['_jornada'] + 60:
                model.Add(carga_ag[ai] >= carga_ag[aj])

    # Objective functions based on Mode
    if MODO == 'EQUILIBRADO':
        max_c = model.NewIntVar(0, V, 'mc')
        min_c = model.NewIntVar(0, V, 'nc')
        model.AddMaxEquality(max_c, carga_ag)
        model.AddMinEquality(min_c, carga_ag)
        diff = model.NewIntVar(0, V, 'd')
        model.Add(diff == max_c - min_c)
        model.Minimize(diff)
    elif MODO == 'PROPORCIONAL':
        model.Maximize(sum(x[ai][vi]*activos[ai]['_jornada'] for ai in range(A) for vi in range(V)))

    # Solve model
    solver.parameters.max_time_in_seconds = 60.0
    status = solver.Solve(model)

    # Capture standard output for the 5 Colab Reports!
    stdout_capture = io.StringIO()
    
    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        # 3. BUILD REVENUE & REPORT OUTPUTS (FROM COLAB OUTPUT SECTIONS)
        asign = {vkey(v): [] for v in VUELOS}
        por_ag = {a['nombre']: [] for a in activos}
        for ag in AGENTES:
            if ag.get('excluir_embarque') and not ag['excluir']:
                por_ag[ag['nombre']] = []
        for ai, ag in enumerate(activos):
            for vi, v in enumerate(VUELOS):
                if solver.Value(x[ai][vi]) == 1:
                    asign[vkey(v)].append(ag)
                    por_ag[ag['nombre']].append(v)

        with contextlib.redirect_stdout(stdout_capture):
            # ─────────────────────────────────────────────────────────────
            # SALIDA 1 — TURNOS DEL PERSONAL
            # ─────────────────────────────────────────────────────────────
            print("═"*72); print("TURNOS DEL PERSONAL"); print("═"*72)
            secciones = [
                ("TURNO MAÑANA · Roles Administrativos - Operativos",
                 [a for a in AGENTES if a['rol'] in ROLES_NO_EMBARCAN and a['_t_ini'] < SPLIT]),
                ("TURNO MAÑANA · Agentes de Pasaje",
                 [a for a in AGENTES if a['rol'] not in ROLES_NO_EMBARCAN and a['_t_ini'] < SPLIT and not a['excluir'] and not a.get('excluir_embarque')]),
                ("TURNO MAÑANA · Solo cobertura de departamento",
                 [a for a in AGENTES if a.get('excluir_embarque') and not a['excluir'] and a['_t_ini'] < SPLIT]),
                ("TURNO MAÑANA · Excluidos hoy",
                 [a for a in AGENTES if a['excluir'] and a['_t_ini'] < SPLIT]),
                ("TURNO TARDE · Roles Administrativos - Operativos",
                 [a for a in AGENTES if a['rol'] in ROLES_NO_EMBARCAN and a['_t_ini'] >= SPLIT]),
                ("TURNO TARDE · Agentes de Pasaje",
                 [a for a in AGENTES if a['rol'] not in ROLES_NO_EMBARCAN and a['_t_ini'] >= SPLIT and not a['excluir'] and not a.get('excluir_embarque')]),
                ("TURNO TARDE · Solo cobertura de departamento",
                 [a for a in AGENTES if a.get('excluir_embarque') and not a['excluir'] and a['_t_ini'] >= SPLIT]),
                ("TURNO TARDE · Excluidos hoy",
                 [a for a in AGENTES if a['excluir'] and a['_t_ini'] >= SPLIT]),
            ]
            for titulo, grupo in secciones:
                if not grupo: continue
                print(f"\n── {titulo}")
                for a in grupo:
                    b2 = f" / {a['bloque2']['inicio']}–{a['bloque2']['fin']}" if a['bloque2'] else ""
                    esp = f" [{'/'.join(a['espec'])}]" if a['espec'] and a['rol'] not in ROLES_OPERATIVOS else ""
                    nota = " ← SOLO COBERTURA" if a.get('excluir_embarque') else (" ← EXCLUIDO" if a['excluir'] else "")
                    print(f"  {a['nombre']:<15} {a['inicio']}–{a['fin']}{b2:<20} {a['rol']}{esp}{nota}")
            n_excluir_emb = sum(1 for a in AGENTES if a.get('excluir_embarque') and not a['excluir'])
            print(f"\n  Total nómina: {len(AGENTES)} · CSA embarcan: {len(activos)} · Solo cobertura: {n_excluir_emb} · Ausentes: {sum(1 for a in AGENTES if a['excluir'])}")
            print(f"  Modo: {MODO}"); print("─"*72)

            # ─────────────────────────────────────────────────────────────
            # SALIDA 2 — PARRILLA
            # ─────────────────────────────────────────────────────────────
            print("\n"+"═"*72); print(f"PARRILLA DE EMBARQUES  [{MODO}]"); print("═"*72)
            print(f"{'Nº':<4}{'DEST':<5}{'VUELO':<10}{'APERTU':<8}{'AGENTES':<30}{'EMB':<7}{'STD'}"); print("─"*72)
            for v in VUELOS_ORD:
                ags = asign[vkey(v)]
                noms = [a['nombre'] for a in ags]
                suf = (' (CH)' if v['charter'] else '') + (' [MAN]' if v['manual'] else '')
                warn = ' ⚠️' if len(noms) < v['agentes_req'] else ''
                if len(noms) == 0:
                    ag_s = "⛔ SIN AGENTES"
                elif len(noms) == 1:
                    ag_s = noms[0]
                elif len(noms) == 2:
                    ag_s = f"{noms[0]} / {noms[1]}"
                else:
                    ag_s = f"{noms[0]} / {noms[1]} / {noms[2]}"
                print(f"{v['num']:<4}{v['destino']:<5}{v['codigo']+suf:<10}{m2t(v['std_min']-180):<8}{ag_s+warn:<30}{m2t(v['emb_inicio']):<7}{v['std']}")

            # ─────────────────────────────────────────────────────────────
            # SALIDA 3 — TOLERANCIAS
            # ─────────────────────────────────────────────────────────────
            print("\n"+"═"*72); print("TOLERANCIAS"); print("═"*72); hay_tol = False
            for ag in activos:
                vag = sorted(por_ag[ag['nombre']], key=lambda v: v['emb_inicio'])
                disp = ag['_t_ini'] + 30
                for idx, v in enumerate(vag):
                    de = disp - v['emb_inicio']
                    if de > 0:
                        hay_tol = True
                        cat = "Tolerable" if de <= 10 else "No aceptable"
                        icon = "⚠️ " if de <= 10 else "🔴"
                        print(f"{icon} {ndisp(ag)} ({hor_turno_completo(ag)}) — L{v['num']} {v['destino']}: EMB {m2t(v['emb_inicio'])}, entrada {ag['inicio']}+30={m2t(disp)}. ❌ {de} min. {cat}.")
                    if idx == len(vag) - 1:
                        ex = v['std_min'] + 15 - ag['_t_fin']
                        if ex > 0:
                            hay_tol = True
                            cat = "Tolerable" if ex <= 5 else "No aceptable"
                            icon = "⚠️ " if ex <= 5 else "🔴"
                            print(f"{icon} {ndisp(ag)} ({hor_turno_completo(ag)}) — L{v['num']} {v['destino']}: STD {v['std']}+15={m2t(v['std_min']+15)} > {m2t(ag['_t_fin'])}. ❌ {ex} min. {cat}.")
                    if idx < len(vag) - 1:
                        sig = vag[idx+1]
                        gr = sig['emb_inicio'] - v['emb_inicio']
                        gm = gap_minimo(v['zona'], sig['zona'])
                        gt = gap_tolerancia(v['zona'], sig['zona'])
                        zs = "misma zona" if v['zona'] == sig['zona'] else "distinta zona"
                        if gr < gm:
                            hay_tol = True
                            deficit = gm - gr
                            cat = "Tolerable" if gr >= gt else ("Solo si inevitable" if deficit <= 15 else "No aceptable")
                            icon = "⚠️ " if gr >= gt else ("🟡" if deficit <= 15 else "🔴")
                            print(f"{icon} {ndisp(ag)} — L{v['num']} {v['destino']} → L{sig['num']} {sig['destino']}: {m2t(v['emb_inicio'])}→{m2t(sig['emb_inicio'])}: {gr} min [{zs}]. ❌ {deficit} min. {cat}.")
            if not hay_tol:
                print("✅ Sin tolerancias")

            # ─────────────────────────────────────────────────────────────
            # SALIDA 4 — LISTADO POR CANTIDAD DE EMBARQUES
            # ─────────────────────────────────────────────────────────────
            print("\n"+"═"*72); print("LISTADO POR CANTIDAD DE EMBARQUES"); print("═"*72)
            _emb = [a for a in todos_csa if len(por_ag.get(a['nombre'], [])) > 0]
            _sin = [a for a in todos_csa if len(por_ag.get(a['nombre'], [])) == 0]
            print(f"👥 Agentes CSA en listado: {len(todos_csa)}   ✈️ Con embarques: {len(_emb)}   💤 Sin embarques: {len(_sin)}")
            for ag in sorted(todos_csa, key=lambda a: (-len(por_ag.get(a['nombre'], [])), a['_t_ini'], -a['_jornada'], a['nombre'])):
                vag = sorted(por_ag[ag['nombre']], key=lambda v: v['emb_inicio'])
                n = len(vag)
                comp = {}
                for v in vag:
                    for ag2 in asign[vkey(v)]:
                        if ag2['nombre'] != ag['nombre']:
                            comp[ag2['nombre']] = comp.get(ag2['nombre'], 0) + 1
                comp_s = ', '.join([f"siempre con {c}" if cnt == n and n > 0 else f"con {c} ({cnt}x)" for c, cnt in comp.items()])
                lbl = f"{n} embarque{'s' if n != 1 else ''}"
                print(f"\n{lbl}:")
                if n == 0:
                    print(f"  {ndisp(ag)} ({hor_turno_completo(ag)}) — Sin asignación")
                else:
                    print(f"  {ndisp(ag)} ({hor_turno_completo(ag)}), {comp_s}")
                    for v in vag:
                        print(f"    L{v['num']:>2} {v['destino']} {v['codigo']}  EMB {m2t(v['emb_inicio'])} STD {v['std']}")

            # ─────────────────────────────────────────────────────────────
            # SALIDA 5 — DESCANSOS
            # ─────────────────────────────────────────────────────────────
            print("\n"+"═"*72); print("DESCANSOS"); print("═"*72)
            _oblig_desc = [a for a in todos_csa if a['_jornada'] > 360]
            _recom_desc = [a for a in todos_csa if a['_jornada'] == 360]
            _op_desc = [a for a in AGENTES if a['rol'] in ROLES_OPERATIVOS and not a['excluir'] and a['_jornada'] > 360]
            print(f"👥 Resumen: 🔴 CSA >6h (obligatorio): {len(_oblig_desc)}  🟡 CSA =6h (recomendable): {len(_recom_desc)}  🔵 Operativo >6h: {len(_op_desc)}")
            
            def tramos_agente(ag):
                vag = sorted(por_ag[ag['nombre']], key=lambda v: v['emb_inicio'])
                t = []
                if vag and vag[0]['emb_inicio'] > ag['_t_ini']:
                    t.append((ag['_t_ini'], vag[0]['emb_inicio'], 'inicio jornada', f"L{vag[0]['num']} {vag[0]['destino']}"))
                for i in range(len(vag)-1):
                    v1, v2 = vag[i], vag[i+1]
                    if v2['emb_inicio'] > v1['std_min']:
                        t.append((v1['std_min'], v2['emb_inicio'], f"L{v1['num']} {v1['destino']}", f"L{v2['num']} {v2['destino']}"))
                if vag:
                    u = vag[-1]
                    if ag['_t_fin'] > u['std_min']:
                        t.append((u['std_min'], ag['_t_fin'], f"L{u['num']} {u['destino']}", 'fin jornada'))
                return vag, t

            def imprimir_descanso_csa(ag):
                vag, t = tramos_agente(ag)
                mid = ag['_midpoint']
                exc_emb = ag.get('excluir_embarque', False)
                nota = " · solo cobertura" if exc_emb else ""
                print(f"\n{ndisp(ag)} ({ag['inicio']}–{ag['fin']} / {dur_str(ag['_jornada'])} ){nota} — {len(vag)} embarques")
                if not vag:
                    print("  Todo el turno libre ✅")
                    if exc_emb and ag['espec']:
                        print(f"  Disponible para cobertura [{'/'.join(ag['espec'])}] durante todo su turno")
                    return
                mid_ok = False
                hay_ok_2a = False
                for ts, te, d, h in t:
                    if not mid_ok and ts >= mid:
                        print(f"  ── desde {m2t(mid)} descanso preferible ──────────────")
                        mid_ok = True
                    elif not mid_ok and te > mid:
                        print(f"  ── mitad de jornada: {m2t(mid)} ──────────────────────")
                        mid_ok = True
                    mins = te - ts
                    avail = te - max(ts, mid) if te > mid else 0
                    icon = icono_break(avail) if avail > 0 else ""
                    print(f"  Entre {d} ({m2t(ts)}) y {h} ({m2t(te)}): {dur_str(mins)} {icon}")
                    if avail >= 70:
                        hay_ok_2a = True
                if not mid_ok:
                    print(f"  ── desde {m2t(mid)} descanso preferible ──────────────")
                if ag['_jornada'] > 360 and not hay_ok_2a:
                    max_a = max((min(te, ag['_t_fin']) - max(ts, mid) for ts, te, _, __ in t if te > mid), default=0)
                    print(f"  ⚠️  Sin tramo ≥70 min desde {m2t(mid)} — disponible: {dur_str(max_a)} — PSM")

            def ventanas_libres(ag, desde, hasta):
                vag = sorted(por_ag.get(ag['nombre'], []), key=lambda v: v['emb_inicio'])
                wins, prev = [], desde
                for v in vag:
                    if v['std_min'] <= desde:
                        prev = max(prev, v['std_min'])
                        continue
                    if v['emb_inicio'] >= hasta:
                        break
                    gs = max(prev, desde)
                    ge = min(v['emb_inicio'], hasta)
                    if ge - gs >= 55:
                        wins.append((gs, ge, ge-gs))
                    prev = max(prev, v['std_min'])
                gs = max(prev, desde)
                if hasta - gs >= 55:
                    wins.append((gs, hasta, hasta-gs))
                return wins

            def descanso_requerido_cobertura(ag):
                if ag['_jornada'] > 360:
                    return 70
                if ag['_jornada'] == 360:
                    return 55
                return 0

            def hay_descanso_disjunto(ag, ex_s, ex_e, req):
                if req <= 0:
                    return True
                for ws, we, wd in ventanas_libres(ag, ag['_midpoint'], ag['_t_fin']):
                    if min(we, ex_s) - ws >= req:
                        return True
                    if we - max(ws, ex_e) >= req:
                        return True
                return False

            def cobertura_dept(dept, op_ag, desde, hasta):
                result = []
                for col in AGENTES:
                    if col['rol'] == dept and col['nombre'] != op_ag['nombre'] and not col['excluir']:
                        ol_s = max(desde, col['_t_ini'])
                        ol_e = min(hasta, col['_t_fin'])
                        if ol_e - ol_s >= 55:
                            result.append(('🔵 Colega', ndisp(col), ol_s, ol_e))
                for cov in cobertura_pool:
                    if dept not in cov['espec']:
                        continue
                    ss = max(desde, cov['_t_ini'])
                    se = min(hasta, cov['_t_fin'])
                    if se - ss < 55:
                        continue
                    wins = ventanas_libres(cov, ss, se)
                    if not wins:
                        continue
                    req = descanso_requerido_cobertura(cov)
                    for ws, we, wd in wins:
                        if wd < 55:
                            continue
                        if req == 0 or hay_descanso_disjunto(cov, ws, we, req) or wd >= req + 55:
                            result.append(('🟢 CSA', ndisp(cov), ws, we))
                return result

            # Sort and print breaks
            sort_desc_key = lambda a: (a['_t_ini'], -a['_jornada'], -len(por_ag.get(a['nombre'], [])), a['nombre'])
            oblig = sorted([a for a in todos_csa if a['_jornada'] > 360], key=sort_desc_key)
            recom = sorted([a for a in todos_csa if a['_jornada'] == 360], key=sort_desc_key)
            
            if oblig:
                print("\n▶ CSA — DESCANSO OBLIGATORIO (jornada >6h)")
                for ag in oblig:
                    imprimir_descanso_csa(ag)
            if recom:
                print("\n▶ CSA — DESCANSO RECOMENDABLE (jornada =6h)")
                for ag in recom:
                    imprimir_descanso_csa(ag)
            
            op_necesitan = sorted([a for a in AGENTES if a['rol'] in ROLES_OPERATIVOS and not a['excluir'] and a['_jornada'] > 360], key=lambda a: (a['_t_ini'], -a['_jornada'], a['nombre']))
            if op_necesitan:
                print("\n▶ PERSONAL OPERATIVO — DESCANSO OBLIGATORIO (jornada >6h)")
                for ag in op_necesitan:
                    dept = ag['rol']
                    mid = ag['_midpoint']
                    print(f"\n{ndisp(ag)} ({ag['inicio']}–{ag['fin']} / {dur_str(ag['_jornada'])})")
                    cob_norm = cobertura_dept(dept, ag, mid, ag['_t_fin'])
                    cob_antes = cobertura_dept(dept, ag, ag['_t_ini'], mid)
                    if cob_norm:
                        print(f"  Descanso desde {m2t(mid)} — cobertura disponible:")
                        seen = set()
                        for tipo, nombre, s, e in sorted(cob_norm, key=lambda x: -(x[3]-x[2]))[:4]:
                            k = f"{nombre}{s}{e}"
                            if k in seen:
                                continue
                            seen.add(k)
                            print(f"    {tipo} {nombre}: {m2t(s)}–{m2t(e)} ({dur_str(e-s)}) {icono_break(e-s)}")
                    elif cob_antes:
                        print(f"  ⚠️  Sin cobertura desde {m2t(mid)} — caso excepcional")
                        print(f"  Descanso antes de la mitad de jornada:")
                        seen = set()
                        for tipo, nombre, s, e in sorted(cob_antes, key=lambda x: -(x[3]-x[2]))[:4]:
                            k = f"{nombre}{s}{e}"
                            if k in seen:
                                continue
                            seen.add(k)
                            print(f"    {tipo} {nombre}: {m2t(s)}–{m2t(e)} ({dur_str(e-s)}) {icono_break(e-s)}")
                    else:
                        print(f"  ⚠️  Sin cobertura disponible para {dept} — comunicar al PSM")
                        
            print("\n"+"═"*72); print(f"FIN — AZUL HANDLING · {MODO}"); print("═"*72)

        # Map mapped results for the frontend daily visual schedule table
        results_mapped = {}
        for vi, v in enumerate(VUELOS):
            ags = asign[vkey(v)]
            # We map flight's db ID to the assigned agent ID (or the first agent in the list for visual grid)
            # Since in your visual grid, a flight is assigned to exactly 1 agent, we take the first assigned agent
            if ags:
                # Find the agent ID in the original agents list
                for ag_in in agents_input:
                    if ag_in.name == ags[0]['nombre']:
                        results_mapped[str(v['id'])] = ag_in.id
                        break
            
        return {
            "success": True,
            "status": "OPTIMAL" if status in (cp_model.OPTIMAL, cp_model.FEASIBLE) else "FEASIBLE",
            "assignments": results_mapped,
            "report_text": stdout_capture.getvalue() # ¡TU REPORTE DE CONSOLA DE COLAB COMPLETO!
        }
    else:
        return {
            "success": False,
            "status": "INFEASIBLE",
            "message": "No se pudo encontrar un cuadrante viable respetando tus descansos y horarios."
        }

# DEMO Fallback Data (Sábado 20 Junio)
DEMO_AGENTS = [
    { "id": 1, "name": "CARO", "hours": "04:15-14:15", "role": "DSM", "type": "admin" },
    { "id": 2, "name": "DÉBORA", "hours": "02:45-12:45", "role": "PSM", "type": "admin" },
    { "id": 3, "name": "GASTÓN", "hours": "06:45-16:45", "role": "PSM", "type": "admin" },
    { "id": 4, "name": "MOI", "hours": "04:45-14:45", "role": "OPS", "type": "admin" },
    { "id": 5, "name": "BEGO", "hours": "05:00-13:00", "role": "OPS", "type": "admin" },
    { "id": 6, "name": "LIZ", "hours": "03:30-11:30", "role": "TKT", "type": "admin" },
    { "id": 7, "name": "CAROL", "hours": "09:00-16:00", "role": "TKT", "type": "admin" },
    { "id": 8, "name": "CRISTI", "hours": "07:15-15:15", "role": "LL", "type": "admin" },
    { "id": 9, "name": "IRENE", "hours": "02:45-08:10", "role": "CSA", "type": "pasaje" },
    { "id": 10, "name": "STEFANIA", "hours": "02:45-08:45", "role": "CSA", "type": "pasaje" },
    { "id": 11, "name": "MARU", "hours": "03:30-08:00", "role": "CSA", "type": "pasaje" },
    { "id": 12, "name": "ASMA", "hours": "03:30-08:10", "role": "CSA", "type": "pasaje" },
    { "id": 13, "name": "ALEJANDRA", "hours": "03:45-06:00", "role": "CSA", "type": "pasaje" },
    { "id": 14, "name": "ALEJANDRO", "hours": "03:45-06:00", "role": "CSA", "type": "pasaje" },
    { "id": 15, "name": "CATHERINE", "hours": "04:35-07:10", "role": "CSA", "type": "pasaje" },
    { "id": 16, "name": "VICTORIA", "hours": "04:35-07:25", "role": "CSA", "type": "pasaje" },
    { "id": 17, "name": "GUILLE", "hours": "04:35-07:25", "role": "CSA", "type": "pasaje" },
    { "id": 18, "name": "MARTA A.", "hours": "04:35-11:25", "role": "CSA [TKT]", "type": "pasaje" },
    { "id": 19, "name": "NURIA G.", "hours": "04:35-11:25", "role": "CSA [OPS]", "type": "pasaje" },
    { "id": 20, "name": "OMAR", "hours": "04:35-12:20", "role": "CSA", "type": "pasaje" },
    { "id": 21, "name": "MARTA C.", "hours": "04:35-12:20", "role": "CSA [OPS]", "type": "pasaje" },
    { "id": 22, "name": "ANASTASIYA", "hours": "04:50-07:25", "role": "CSA", "type": "pasaje" },
    { "id": 23, "name": "JORGE N.", "hours": "04:55-11:25", "role": "CSA [TKT]", "type": "pasaje" },
    { "id": 24, "name": "LETI", "hours": "04:55-11:25", "role": "CSA", "type": "pasaje" }
]

DEMO_FLIGHTS = [
    { "id": 1, "destination": "MAN", "airline": "FR", "number": "FR3209", "time": "05:45", "agents": "" },
    { "id": 2, "destination": "EMA", "airline": "FR", "number": "FR4459", "time": "05:45", "agents": "" },
    { "id": 3, "destination": "NUE", "airline": "FR", "number": "FR5094", "time": "05:45", "agents": "" },
    { "id": 4, "destination": "BOH", "airline": "FR", "number": "FR5945", "time": "06:00", "agents": "" },
    { "id": 5, "destination": "BRE", "airline": "FR", "number": "FR9929", "time": "06:05", "agents": "" },
    { "id": 6, "destination": "LBA", "airline": "FR", "number": "FR2447", "time": "06:15", "agents": "" },
    { "id": 7, "destination": "MME", "airline": "FR", "number": "FR3374", "time": "06:20", "agents": "" },
    { "id": 8, "destination": "BUD", "airline": "FR", "number": "FR2274", "time": "06:25", "agents": "" },
    { "id": 9, "destination": "WMI", "airline": "FR", "number": "FR4059", "time": "06:30", "agents": "" },
    { "id": 10, "destination": "TNG", "airline": "FR", "number": "FR9587", "time": "06:30", "agents": "" },
    { "id": 11, "destination": "CRL", "airline": "FR", "number": "FR1915", "time": "06:45", "agents": "" },
    { "id": 12, "destination": "AAR", "airline": "FR", "number": "FR4695", "time": "06:50", "agents": "" },
    { "id": 13, "destination": "OPO", "airline": "FR", "number": "FR5046", "time": "06:55", "agents": "" },
    { "id": 14, "destination": "RAK", "airline": "FR", "number": "FR3909", "time": "07:00", "agents": "" },
    { "id": 15, "destination": "FMO", "airline": "FR", "number": "FR3368", "time": "07:10", "agents": "" },
    { "id": 16, "destination": "GOT", "airline": "FR", "number": "FR91",   "time": "07:10", "agents": "" },
    { "id": 17, "destination": "BER", "airline": "FR", "number": "FR233",  "time": "07:20", "agents": "" },
    { "id": 18, "destination": "ABZ", "airline": "FR", "number": "FR8007", "time": "07:25", "agents": "" },
    { "id": 19, "destination": "EIN", "airline": "FR", "number": "FR2575", "time": "07:45", "agents": "" },
    { "id": 20, "destination": "VLC", "airline": "FR", "number": "FR645",  "time": "08:10", "agents": "" },
    { "id": 21, "destination": "BCN", "airline": "FR", "number": "FR3081", "time": "08:20", "agents": "" },
    { "id": 22, "destination": "FCO", "airline": "FR", "number": "FR6139", "time": "09:05", "agents": "" },
    { "id": 23, "destination": "PRG", "airline": "FR", "number": "FR6658", "time": "09:15", "agents": "" },
    { "id": 24, "destination": "BLQ", "airline": "FR", "number": "FR8933", "time": "09:25", "agents": "" },
    { "id": 25, "destination": "VIE", "airline": "FR", "number": "FR703",  "time": "09:55", "agents": "" },
    { "id": 26, "destination": "ZAG", "airline": "FR", "number": "FR600",  "time": "10:00", "agents": "" }
]

@app.post("/extract")
async def extract_data(model: Optional[str] = "gpt-5.4-nano", files: List[UploadFile] = File(...), authorization: Optional[str] = Header(None)):
    """
    Extracción multimodal por IA (catálogo de GPT-5) de compatibilidad absoluta.
    Realiza una cascada inteligente unificada (Llamada + Decodificación JSON)
    para asegurar éxito absoluto en cualquier condición.
    """
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        return {
            "success": True,
            "is_real_ai": False,
            "message": "Servidor sin clave API Key de OpenAI configurada. No se cargaron datos ficticios.",
            "date": "Fecha no detectada",
            "agents": [],
            "flights": []
        }

    try:
        import openpyxl
        import pypdf
        from openai import OpenAI
        
        client = OpenAI(api_key=api_key)

        user_content_blocks = []
        text_payloads = []

        for file in files:
            filename_lower = file.filename.lower()
            content = await file.read()
            
            # --- CASO 1: EXCEL (.xlsx, .xls) ---
            if filename_lower.endswith(('.xlsx', '.xls')):
                try:
                    excel_file = io.BytesIO(content)
                    wb = openpyxl.load_workbook(excel_file, data_only=True)
                    
                    sheet_texts = []
                    for sheet_name in wb.sheetnames:
                        ws = wb[sheet_name]
                        rows_str = []
                        for row in ws.iter_rows(values_only=True):
                            row_str = " | ".join(str(val).strip() if val is not None else "" for val in row)
                            if row_str.replace(" |", "").strip():
                                rows_str.append(row_str)
                        
                        sheet_texts.append(f"### Hoja: {sheet_name}\n" + "\n".join(rows_str))
                    
                    excel_text = "\n\n".join(sheet_texts)
                    text_payloads.append(f"--- CONTENIDO EXCEL ({file.filename}) ---\n{excel_text}\n")
                except Exception as excel_err:
                    print(f"Error leyendo Excel {file.filename}: {excel_err}")
            
            # --- CASO 2: PDF (.pdf) ---
            elif filename_lower.endswith('.pdf'):
                try:
                    pdf_file = io.BytesIO(content)
                    pdf_reader = pypdf.PdfReader(pdf_file)
                    pdf_text_list = []
                    for page_idx, page in enumerate(pdf_reader.pages):
                        txt = page.extract_text()
                        if txt:
                            pdf_text_list.append(f"--- Página {page_idx + 1} ---\n{txt}")
                    
                    pdf_text = "\n\n".join(pdf_text_list)
                    text_payloads.append(f"--- CONTENIDO PDF ({file.filename}) ---\n{pdf_text}\n")
                except Exception as pdf_err:
                    print(f"Error leyendo PDF {file.filename}: {pdf_err}")
            
            # --- CASO 3: IMÁGENES ---
            else:
                try:
                    base64_image = base64.b64encode(content).decode('utf-8')
                    mime_type = "image/png"
                    if filename_lower.endswith(('.jpg', '.jpeg')):
                        mime_type = "image/jpeg"
                    elif filename_lower.endswith('.gif'):
                        mime_type = "image/gif"
                    elif filename_lower.endswith('.webp'):
                        mime_type = "image/webp"
                    
                    user_content_blocks.append({
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:{mime_type};base64,{base64_image}"
                        }
                    })
                except Exception as img_err:
                    print(f"Error cargando imagen {file.filename}: {img_err}")

        # Añadimos una instrucción textual de seguridad al usuario para que los modelos de visión de GPT-5 tengan texto guía obligatorio
        user_content_blocks.append({
            "type": "text",
            "text": "Analiza esta imagen o contenido de texto y extrae la fecha, los agentes y los vuelos en el formato JSON de rellenado solicitado."
        })

        if text_payloads:
            combined_text = "\n".join(text_payloads)
            user_content_blocks.append({
                "type": "text",
                "text": (
                    "Aquí tienes el contenido de texto extraído directamente del archivo Excel/PDF cargado.\n"
                    "Analízalo con precisión para extraer los agentes, sus horarios, los vuelos y la fecha de la cabecera:\n\n"
                    f"{combined_text}"
                )
            })

        system_prompt = (
            "Eres un sistema especializado en la extracción documental de máxima precisión.\n"
            "Tu única función es extraer literalmente todo el contenido visible de la imagen.\n"
            "La imagen puede contener tablas, texto impreso, texto manuscrito, sellos, firmas, columnas, encabezados y anotaciones.\n"
            "Debes analizar la imagen varias veces antes de generar la respuesta.\n\n"
            "Normas obligatorias:\n"
            "- No resumas el contenido.\n"
            "- No traduzcas el texto.\n"
            "- No interpretes el significado.\n"
            "- No corrijas errores ortográficos.\n"
            "- No inventes información.\n"
            "- No completes información que no sea visible.\n"
            "- Conserva exactamente las mayúsculas, las minúsculas, los acentos, la puntuación y el orden del documento.\n"
            "- Si existe alguna duda sobre un valor, indícalo con el prefijo «INCERTIDUMBRE:».\n"
            "- Comprueba varias veces el resultado antes de devolver la respuesta.\n"
            "- Comprueba que todas las filas de la tabla se hayan extraído correctamente.\n"
            "- Comprueba que no existan nombres sin horarios.\n"
            "- Comprueba que no existan horarios sin nombres.\n"
            "- Comprueba que el número de elementos extraídos coincida con el número de elementos visibles.\n"
            "- Si la imagen contiene varias tablas, extrae cada una por separado.\n"
            "- Si la imagen contiene una estructura de filas y columnas, respétala.\n"
            "- Si una línea aparece cortada, extrae únicamente la parte visible.\n"
            "- Si el texto está parcialmente oculto, indica que es ilegible.\n"
            "- Nunca omitas información.\n\n"
            "Proceso interno obligatorio:\n"
            "1. Analiza la imagen completa.\n"
            "2. Analiza la parte superior.\n"
            "3. Analiza la parte central.\n"
            "4. Analiza la parte inferior.\n"
            "5. Analiza la columna izquierda.\n"
            "6. Analiza la columna derecha.\n"
            "7. Compara todos los resultados.\n"
            "8. Corrige posibles errores.\n"
            "9. Genera la respuesta final.\n\n"
            "Devuelve exclusivamente un objeto JSON.\n"
            "La estructura debe ser la siguiente:\n"
            "{\n"
            "  \"fecha\": \"DOMINGO 21 JUNIO\",\n"
            "  \"titulo\": \"AZUL HANDLING\",\n"
            "  \"observaciones\": \"\",\n"
            "  \"manana\": [\n"
            "    {\"tipo_elemento\": \"agente\", \"nombre\": \"CARO\", \"horario\": \"04:15-14:15\", \"rol\": \"DSM\"}\n"
            "  ],\n"
            "  \"tarde\": [\n"
            "    {\"tipo_elemento\": \"agente\", \"nombre\": \"SERGIO\", \"horario\": \"14:00-00:00\", \"rol\": \"DSM\"}\n"
            "  ]\n"
            "}\n\n"
            "### REGLAS DE ESTRUCTURA INTERNA PARA LOS ELEMENTOS EN \"manana\" y \"tarde\":\n"
            "1. Para los Turnos de Personal (Horarios):\n"
            "- A LA MANO IZQUIERDA de la hoja están los turnos de la MAÑANA (añade a la lista \"manana\"). A LA MANO DERECHA de la TARDE (añade a la lista \"tarde\").\n"
            "- Bloque superior de la columna: turnos administrativos-operativos con el rol en paréntesis, ej: 'CARO (DSM)' se extrae con nombre 'CARO' y rol 'DSM'. El bloque superior de cada columna tiene exactamente 5 filas impresas (ej: DSM, PSM, OPS, TKT, LL). La quinta fila siempre pertenece al departamento de Llegadas (LL) (ej: 'CARMEN L (LL) // CRISTI R (LL)'). Asegúrate de extraer SIEMPRE a estas personas de la 5ª fila como de rol 'LL' y de tipo 'admin' (¡nunca los desplaces al bloque inferior de agentes de pasaje!).\n"
            "- Bloque inferior de la columna: turnos de Pasaje (CSA). Aquí el rol 'CSA' NO aparece escrito (aparece vacío, solo sale el nombre, ej: 'STEFANIA'). Debes extraerlos con rol 'CSA' de forma automática, salvo que lleven restricciones entre paréntesis (ej: 'EVA (SOMBRA TKT)', que se extrae con rol 'TKT').\n"
            "- Si en una fila hay dos personas separadas por '/' (ej: 'JORGE / GASTÓN (PSM)' con horarios '02:45-12:45 / 06:45-16:45'), debes crear dos objetos individuales en la lista correspondientemente:\n"
            "  * Uno con nombre 'JORGE', horario '02:45-12:45', rol 'PSM'.\n"
            "  * Otro con nombre 'GASTÓN', horario '06:45-16:45', rol 'PSM'.\n"
            "\n"
            "2. Para la Parrilla de Vuelos / Embarques:\n"
            "Cada vuelo debe extraerse en este formato dentro de \"manana\" (si es temprano) o \"tarde\" (si es tarde):\n"
            "{\n"
            "  \"tipo_elemento\": \"vuelo\",\n"
            "  \"destino\": \"SNN\",\n"
            "  \"linea_aerea\": \"FR\",\n"
            "  \"numero_vuelo\": \"FR2849\",\n"
            "  \"std\": \"05:45\"\n"
            "}\n"
            "- ¡¡¡MUY IMPORTANTE PARA LA HORA DEL VUELO (std)!!!: Extrae estrictamente de la columna o celda 'STD' (ej: '5:45' -> '05:45'). ¡NUNCA extraigas la hora de la columna 'APERTU' (ej: '2:45') ni 'CIERRE' (ej: '5:05') como 'std' del vuelo! Si la columna 'APERTU' dice '2:45' y 'STD' dice '5:45', el std que debes extraer es '05:45'.\n"
            "- 'date' (fecha) debe ser la fecha del documento. PRIORIZA siempre leer cualquier fecha manuscrita con bolígrafo de cualquier tinta o color (azul, negro, rojo, etc.) que aparezca anotada a mano en el papel (ej: '24/06/26' o '21/06/26'). Si no la hay, lee la fecha impresa en la cabecera (ej: 'DOMINGO 21 JUNIO'). Si no encuentras ninguna, pon 'Fecha no detectada' por defecto (¡bajo ningún concepto te inventes una fecha ficticia!).\n"
            "- Si el documento SOLO contiene vuelos, las listas de agentes deben estar vacías, y viceversa. No inventes datos ficticios."
        )

        # We build the models list, placing the user's selected model at the very front of the cascade!
        selected_model = model or "gpt-5.4-nano"
        use_high_reasoning_default = (selected_model == "gpt-5.6-luna")
        
        models_to_try = [(selected_model, use_high_reasoning_default)]
        for m, h in [("gpt-5.6-luna", True), ("gpt-5.4-nano", False), ("gpt-5.4-mini", False), ("gpt-5-mini", False), ("gpt-4.1-mini", False)]:
            if m != selected_model:
                models_to_try.append((m, h))

        parsed_result = None
        extracted_model_name = ""
        errors = []

        for model_name, use_high_reasoning in models_to_try:
            try:
                print(f"Intentando llamada a {model_name}...")
                params = {
                    "model": model_name,
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_content_blocks}
                    ],
                    "max_completion_tokens": 4000
                }
                
                # Intentamos activar el formato JSON
                params["response_format"] = {"type": "json_object"}
                
                # Intentamos razonamiento alto para todos los modelos por defecto
                params["reasoning_effort"] = "high"
                    
                # Realizamos llamada OpenAI
                try:
                    response = client.chat.completions.create(**params)
                except Exception as call_err:
                    err_msg = str(call_err).lower()
                    print(f"Ajuste defensivo para {model_name} por error: {call_err}")
                    
                    # 1. Si no soporta JSON mode, lo borramos
                    if "response_format" in err_msg or "json" in err_msg:
                        if "response_format" in params:
                            del params["response_format"]
                            
                    # 2. Si el modelo no soporta el razonamiento (reasoning_effort), lo borramos
                    if "reasoning_effort" in err_msg or "unsupported_parameter" in err_msg or "parameter" in err_msg:
                        if "reasoning_effort" in params:
                            del params["reasoning_effort"]
                            
                    # 3. Si no soporta rol system, unimos prompts
                    if "system" in err_msg or "role" in err_msg:
                        merged_content = [
                            {"type": "text", "text": f"INSTRUCCIONES DEL SISTEMA:\n{system_prompt}\n\n"}
                        ]
                        if isinstance(user_content_blocks, list):
                            merged_content.extend(user_content_blocks)
                        else:
                            merged_content.append({"type": "text", "text": str(user_content_blocks)})
                            
                        params["messages"] = [
                            {"role": "user", "content": merged_content}
                        ]
                    
                    # Reintento con parámetros limpios
                    response = client.chat.completions.create(**params)

                # Procesamiento del resultado de este modelo
                raw_result = response.choices[0].message.content
                if not raw_result:
                    try:
                        raw_result = response.choices[0].message.reasoning_content
                    except:
                        pass
                if not raw_result:
                    raise Exception("El servidor OpenAI devolvió contenido vacío.")

                raw_result = raw_result.strip()
                print(f"Respuesta recibida de {model_name} (primeros 150 caracteres): '{raw_result[:150]}'")

                # Limpieza de markdown
                if raw_result.startswith("```"):
                    raw_result = re.sub(r"^```(?:json)?\n", "", raw_result, flags=re.IGNORECASE)
                    raw_result = re.sub(r"\n```$", "", raw_result)
                    raw_result = raw_result.strip()

                # Intento de parseo JSON para este modelo
                try:
                    parsed_result = json.loads(raw_result)
                except json.JSONDecodeError as json_err:
                    # Intento defensivo usando búsqueda de llaves con regex
                    match_json = re.search(r"\{.*\}", raw_result, re.DOTALL)
                    if match_json:
                        parsed_result = json.loads(match_json.group(0))
                    else:
                        raise json_err

                # Si logramos decodificar con éxito, detenemos la cascada
                extracted_model_name = model_name
                break

            except Exception as model_err:
                print(f"Fallo de llamada o decodificación con {model_name}: {model_err}")
                errors.append(f"{model_name}: {str(model_err)}")
                continue

        if parsed_result is None:
            raise Exception(f"Ningún modelo del catálogo logró generar un JSON de rellenado decodificable. Historial de errores: {'; '.join(errors)}")

        extracted_date = parsed_result.get("fecha") or "Fecha no detectada"
        if not extracted_date or extracted_date.strip() == "":
            extracted_date = "Fecha no detectada"
            
        raw_manana = parsed_result.get("manana") or []
        raw_tarde = parsed_result.get("tarde") or []

        formatted_agents = []
        formatted_flights = []
        
        def process_items(items, shift_name):
            for idx, item in enumerate(items):
                if not isinstance(item, dict):
                    continue
                tipo = str(item.get("tipo_elemento") or "").lower().strip()
                
                if not tipo:
                    if "horario" in item or "rol" in item:
                        tipo = "agente"
                    elif "std" in item or "numero_vuelo" in item:
                        tipo = "vuelo"
                        
                if tipo == "agente":
                    name_raw = str(item.get("nombre") or "").upper().strip()
                    hours_raw = str(item.get("horario") or "08:00-16:00").strip()
                    role_upper = str(item.get("rol") or "CSA").upper().strip()
                    
                    # Dividimos nombres múltiples separados por '/' o ','
                    names = [n.strip() for n in name_raw.replace(",", "/").split("/") if n.strip()]
                    
                    # Clasificación estricta: type es "pasaje" (CSA) solo si el rol contiene CSA. De lo contrario, es "admin"
                    agent_type = "admin"
                    if "CSA" in role_upper:
                        agent_type = "pasaje"

                    if len(names) <= 1:
                        # ¡Un solo agente! Conservamos su horario exactamente igual (preservando turnos partidos con '/')
                        formatted_agents.append({
                            "id": len(formatted_agents) + 1,
                            "name": name_raw,
                            "hours": hours_raw,
                            "role": role_upper,
                            "type": agent_type,
                            "shift": shift_name
                        })
                    else:
                        # Múltiples agentes en la misma fila (como Evelin, Paola o Liz / Carol)
                        if agent_type == "pasaje":
                            # Los CSA (pasaje) que comparten fila SIEMPRE comparten el mismo turno partido completo. ¡NO se dividen sus horas!
                            for name_val in names:
                                formatted_agents.append({
                                    "id": len(formatted_agents) + 1,
                                    "name": name_val,
                                    "hours": hours_raw, # Ambos reciben el turno partido completo
                                    "role": role_upper,
                                    "type": agent_type,
                                    "shift": shift_name
                                })
                        else:
                            # Los administrativos (admin) sí que tienen turnos individuales distintos separados por la barra
                            hours_list = [h.strip() for h in hours_raw.replace("//", "/").split("/") if h.strip()]
                            for idx_name, name_val in enumerate(names):
                                hours_val = hours_raw
                                if len(hours_list) == len(names):
                                    hours_val = hours_list[idx_name]
                                elif len(hours_list) > 0:
                                    hours_val = hours_list[min(idx_name, len(hours_list) - 1)]
                                    
                                formatted_agents.append({
                                    "id": len(formatted_agents) + 1,
                                    "name": name_val,
                                    "hours": hours_val,
                                    "role": role_upper,
                                    "type": agent_type,
                                    "shift": shift_name
                                })
                elif tipo == "vuelo":
                    formatted_flights.append({
                        "id": len(formatted_flights) + 1,
                        "destination": str(item.get("destino") or "MAD").upper().strip(),
                        "airline": str(item.get("linea_aerea") or "FR").upper().strip(),
                        "number": str(item.get("numero_vuelo") or f"FL{len(formatted_flights)+1}").upper().strip(),
                        "time": str(item.get("std") or "12:00").strip(),
                        "agents": ""
                    })

        process_items(raw_manana, "mañana")
        process_items(raw_tarde, "tarde")

        return {
            "success": True,
            "is_real_ai": True,
            "message": f"Extracción exitosa completada por {extracted_model_name}.",
            "date": str(extracted_date).strip(),
            "agents": formatted_agents,
            "flights": formatted_flights
        }

    except Exception as e:
        tb = traceback.format_exc()
        print(f"Error calling OpenAI Vision API: {e}\nTraceback: {tb}")
        return {
            "success": True,
            "is_real_ai": False,
            "message": f"Error en la extracción por IA ({str(e)}).\nTraceback: {tb}",
            "date": "Fecha no detectada",
            "agents": [],
            "flights": []
        }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
