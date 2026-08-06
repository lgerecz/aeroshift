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
async def extract_data(files: List[UploadFile] = File(...), authorization: Optional[str] = Header(None)):
    """
    Extracción multimodal ultra-ligera por IA (GPT-4o-mini). Soporta imágenes, PDFs y Excels (openpyxl).
    Incorpora la descripción geográfica detallada de la hoja de turnos y las reglas de color de aerolíneas.
    """
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        return {
            "success": True,
            "is_real_ai": False,
            "message": "Servidor sin clave API Key de OpenAI configurada. No se cargaron datos ficticios para evitar confusiones.",
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
            
            # --- CASO 3: IMÁGENES (png, jpg, jpeg, gif, webp) ---
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

        if not user_content_blocks:
            return {
                "success": True,
                "is_real_ai": False,
                "message": "No se recibieron archivos válidos para extraer.",
                "date": "Fecha no detectada",
                "agents": [],
                "flights": []
            }

        system_prompt = (
            "Eres un asistente de inteligencia artificial experto en lectura y extracción de horarios de aeropuertos.\n"
            "Tu tarea es analizar los datos (imágenes y/o texto de archivos Excel/PDF) y extraer:\n"
            "1. La lista de vuelos programados (vuelos de salida/boarding gates).\n"
            "2. La lista de agentes de pasaje/handling disponibles con sus turnos de trabajo.\n"
            "3. La fecha del horario (ej: 'DOMINGO 21 JUNIO' o 'SÁBADO 20 JUNIO' o '22/06/26') que suele estar en las cabeceras o esquinas superiores de los documentos.\n\n"
            "Debes devolver un objeto JSON estricto con el siguiente esquema exacto de JSON:\n"
            "{\n"
            "  \"date\": \"DOMINGO 21 JUNIO\",\n"
            "  \"agents\": [\n"
            "    {\"id\": 1, \"name\": \"NOMBRE\", \"hours\": \"HH:MM-HH:MM\", \"role\": \"CSA\", \"type\": \"pasaje\"}\n"
            "  ],\n"
            "  \"flights\": [\n"
            "    {\"id\": 1, \"destination\": \"XXX\", \"airline\": \"FR\", \"number\": \"FR123\", \"time\": \"HH:MM\", \"agents\": \"\"}\n"
            "  ]\n"
            "}\n\n"
            "Reglas importantes:\n"
            "- 'date' debe ser la fecha leída de la cabecera del documento, por ejemplo 'DOMINGO 21 JUNIO'. Si no la encuentras o es ilegible, pon 'Fecha no detectada' por defecto (¡bajo ningún concepto te inventes una fecha ficticia!).\n"
            "\n"
            "### ESTRUCTURA GEOGRÁFICA DE LA HOJA DE TURNOS (LEER CON ATENCIÓN):\n"
            "- A LA MANO IZQUIERDA del documento se encuentran los turnos de la MAÑANA; A LA MANO DERECHA los turnos de la TARDE.\n"
            "- EN LA PRIMERA PARTE (bloque superior de cada columna de mañana o tarde) encontrarás los turnos ADMINISTRATIVOS - OPERATIVOS (como DSM, PSM, OPS, TKT, LL), los cuales llevan siempre su departamento/rol entre paréntesis (ej: 'MARINA (DSM)', 'JORGE / PATRI (PSM)').\n"
            "- EN LA SEGUNDA PARTE (bloque inferior de cada columna) se encuentran los turnos de PASAJE (CSA), que representa todo el personal apto para embarcar, salvo que tengan alguna restricción escrita entre paréntesis (ej: 'EVA (SOMBRA TKT)').\n"
            "\n"
            "### REGLA DE ORO DE EXTRACCIÓN PARCIAL (NO INVENTAR DATOS):\n"
            "  * Si el documento cargado SOLO contiene la Parrilla de Vuelos/Embarques y NO contiene los Turnos de Personal, la clave 'agents' del JSON DEBE ser un array vacío: '\"agents\": []'. ¡BAJO NINGÚN CONCEPTO te inventes agentes, roles ni horarios ficticios!\n"
            "  * Si el documento cargado SOLO contiene los Turnos de Personal y NO contiene los Vuelos/Embarques, la clave 'flights' del JSON DEBE ser un array vacío: '\"flights\": []'. ¡BAJO NINGÚN CONCEPTO te inventes destinos, números de vuelo ni horas ficticias!\n"
            "\n"
            "### REGLA PARA FILAS MULTIPERSONALES (separadas por '/'):\n"
            "  Si en una misma fila del cuadrante aparecen dos personas separadas por una barra '/' (ej: 'JORGE / PATRI (PSM)' con horarios '02:45-12:45 / 06:45-16:45'), debes crear DOS objetos de agente distintos e individuales en la lista JSON:\n"
            "  1. Un agente con nombre 'JORGE', horario '02:45-12:45' y rol 'PSM'.\n"
            "  2. Un agente con nombre 'PATRI', horario '06:45-16:45' y rol 'PSM'.\n"
            "  De esta forma, cada persona real tendrá su propio renglón individual en el JSON final.\n"
            "- Cada agente debe tener un id numérico secuencial único.\n"
            "- 'hours' debe tener el formato exacto 'HH:MM-HH:MM' (ej: '04:35-11:25').\n"
            "- 'role' debe ser el código de rol (ej: CSA, DSM, PSM, OPS, TKT, LL).\n"
            "- 'type' debe ser 'pasaje' ÚNICAMENTE si la persona es un CSA o tiene el rol CSA (ej: 'CSA', 'CSA [TKT]', 'CSA [OPS]'). Para cualquier otro rol de la hoja (DSM, PSM, OPS, TKT, LL, etc.), 'type' debe ser estrictamente 'admin'. Únicamente el personal con 'type' = 'pasaje' es apto para embarcar.\n"
            "- Cada vuelo debe tener un id numérico secuencial único.\n"
            "- 'destination' debe ser un código IATA de 3 letras (ej: MAN, CDG, FRA, SNN, OTP, PSA, ORK, PAD, LBC, BUD).\n"
            "- 'airline' debe ser el código de 2 letras de la aerolínea (ej: FR, VY, LH, RR, RK).\n"
            "- ¡¡¡MUY IMPORTANTE PARA LA HORA DE LOS VUELOS (STD)!!!: Para el campo 'time' de los vuelos, DEBES extraer estrictamente el valor de la columna o celda 'STD' (ej: '5:45' -> '05:45'), que representa la hora de salida del vuelo. ¡BAJO NINGÚN CONCEPTO extraigas la hora de la columna 'APERTU' (ej: '2:45') ni 'CIERRE' (ej: '5:05') como 'time' del vuelo! Si la columna 'APERTU' dice '2:45' y la columna 'STD' dice '5:45', la hora que debes extraer es '05:45'.\n"
            "- El campo 'agents' de los vuelos debe estar COMPLETAMENTE VACÍO (un string vacío \"\"). No asignes ningún agente a ningún vuelo en la extracción.\n\n"
            "Devuelve SOLAMENTE el objeto JSON puro sin formato markdown, sin bloques de código ni texto adicional. Si no puedes extraer nada relevante o faltan datos, devuelve un JSON vacío respetando el esquema."
        )

        response = client.chat.completions.create(
            model="gpt-4o",
            messages=[
                {
                    "role": "system",
                    "content": system_prompt
                },
                {
                    "role": "user",
                    "content": user_content_blocks
                }
            ],
            response_format={"type": "json_object"},
            max_tokens=4000,
            temperature=0.0
        )

        raw_result = response.choices[0].message.content.strip()
        parsed_result = json.loads(raw_result)

        extracted_date = parsed_result.get("date") or "Fecha no detectada"
        extracted_agents = parsed_result.get("agents", [])
        extracted_flights = parsed_result.get("flights", [])

        formatted_agents = []
        for idx, ag in enumerate(extracted_agents):
            role_upper = str(ag.get("role") or "CSA").upper().strip()
            
            # Enforce strict classification: type is "pasaje" ONLY if role contains CSA. Otherwise, it is strictly "admin" (non-boarding)
            agent_type = "admin"
            if "CSA" in role_upper:
                agent_type = "pasaje"
                
            formatted_agents.append({
                "id": ag.get("id") or (idx + 1),
                "name": str(ag.get("name") or f"AGENTE_{idx+1}").upper().strip(),
                "hours": str(ag.get("hours") or "08:00-16:00").strip(),
                "role": role_upper,
                "type": agent_type
            })

        formatted_flights = []
        for idx, fl in enumerate(extracted_flights):
            formatted_flights.append({
                "id": fl.get("id") or (idx + 1),
                "destination": str(fl.get("destination") or "MAD").upper().strip(),
                "airline": str(fl.get("airline") or "FR").upper().strip(),
                "number": str(fl.get("number") or f"FL{idx+1}").upper().strip(),
                "time": str(fl.get("time") or "12:00").strip(),
                "agents": ""
            })

        return {
            "success": True,
            "is_real_ai": True,
            "message": f"Extracción exitosa realizada por GPT-4o-mini.",
            "date": str(extracted_date).strip(),
            "agents": formatted_agents,
            "flights": formatted_flights
        }

    except Exception as e:
        print(f"Error calling OpenAI Vision API: {e}")
        return {
            "success": True,
            "is_real_ai": False,
            "message": f"Error en la extracción por IA ({str(e)}). No se han cargado datos ficticios.",
            "date": "Fecha no detectada",
            "agents": [],
            "flights": []
        }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
