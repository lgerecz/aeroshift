// ===== AeroShift — Parrilla de Turnos Handling =====

// ===== DATA STORE =====
const STORAGE_KEY = 'aeroshift_data';

const SHIFTS = {
  morning:   { label: 'Mañana',  start: '06:00', end: '14:00', color: 'var(--morning)' },
  afternoon: { label: 'Tarde',   start: '14:00', end: '22:00', color: 'var(--afternoon)' },
  night:     { label: 'Noche',   start: '22:00', end: '06:00', color: 'var(--night)' }
};

const AIRLINE_COLORS = {
  IB: '#d41414', VY: '#e85d00', UX: '#0066cc', FR: '#f5c518',
  EW: '#ff6600', LH: '#05164d', AF: '#002157', BA: '#2e5c99',
  TK: '#c8102e', OTHER: '#6b7280'
};

const AVATAR_COLORS = [
  '#6366f1', '#ec4899', '#14b8a6', '#f59e0b', '#ef4444',
  '#8b5cf6', '#06b6d4', '#84cc16', '#f97316', '#10b981'
];

let state = loadData();
let currentShiftFilter = 'all';
let dragData = null;
let extractedData = null; // Stores extracted agents and flights from backend
let editingFlightId = null; // Tracks which flight row is being edited
let editingAgentId = null; // Tracks which agent row is being edited
let uploadedFilesCopy = []; // Accumulative list of uploaded file previews
let newlyCreatedAgentId = null;
let newlyCreatedFlightId = null;
let validationParametersSnapshot = null;

// ===== PERSISTENCE =====
function normalizeAgents(agentsList) {
  if (!Array.isArray(agentsList)) return [];
  return agentsList.map(a => {
    const hoursStr = a.hours || '08:00-16:00';
    const blocks = hoursStr.replace(/\/\//g, '/').split('/').map(b => b.trim()).filter(b => b);
    
    let inicio = '08:00';
    let fin = '16:00';
    let bloque2 = null;
    
    if (blocks.length > 0) {
      const parts1 = blocks[0].split('-');
      if (parts1.length === 2) {
        inicio = parts1[0].trim();
        fin = parts1[1].trim();
      }
    }
    if (blocks.length > 1) {
      const parts2 = blocks[1].split('-');
      if (parts2.length === 2) {
        bloque2 = {
          inicio: parts2[0].trim(),
          fin: parts2[1].trim()
        };
      }
    }
    
    const timeToMins = (t) => {
      if (!t || !t.includes(':')) return 0;
      const [h, m] = t.split(':').map(Number);
      return (isNaN(h) || isNaN(m)) ? 0 : h * 60 + m;
    };
    
    const startMins = timeToMins(inicio);
    const endMins = bloque2 ? timeToMins(bloque2.fin) : timeToMins(fin);
    
    const shifts = [];
    if (a.shift === 'mañana' || startMins < 720) {
      shifts.push('morning');
    }
    if (a.shift === 'tarde' || (startMins >= 720 && startMins < 1080) || endMins > 840) {
      shifts.push('afternoon');
    }
    if (endMins >= 1320 || startMins >= 1080) {
      shifts.push('night');
    }
    if (shifts.length === 0) {
      shifts.push('morning');
    }
    
    return {
      id: a.id,
      name: a.name || 'Agente',
      code: a.code || `AG-${String(a.id).padStart(3, '0')}`,
      hours: hoursStr,
      role: a.role || 'CSA',
      rol: a.role || 'CSA',
      type: a.type || 'pasaje',
      shift: a.shift || (startMins < 720 ? 'mañana' : 'tarde'),
      shifts: a.shifts || shifts,
      espec: a.espec || [],
      excluir: a.excluir || false,
      excluir_embarque: a.excluir || false,
      airline: a.airline || '',
      inicio: inicio,
      fin: fin,
      bloque2: bloque2,
      source_row_people: Math.max(1, Number(a.source_row_people || 1)),
      validation_errors: Array.isArray(a.validation_errors) ? a.validation_errors : []
    };
  });
}

function loadData() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed && parsed.agents) {
        parsed.agents = normalizeAgents(parsed.agents);
      }
      return parsed;
    }
  } catch(e) {}
  const def = getDefaultData();
  def.agents = normalizeAgents(def.agents);
  return def;
}

function saveData() {
  if (state && state.agents) {
    state.agents = normalizeAgents(state.agents);
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function getDefaultData() {
  return {
    agents: [
      { id: 1, name: 'Juan García',     code: 'AG-001', shifts: ['morning'],            airline: '' },
      { id: 2, name: 'María López',     code: 'AG-002', shifts: ['morning','afternoon'], airline: 'IB' },
      { id: 3, name: 'Carlos Martínez', code: 'AG-003', shifts: ['afternoon'],           airline: 'VY' },
      { id: 4, name: 'Ana Rodríguez',   code: 'AG-004', shifts: ['afternoon','night'],   airline: '' },
      { id: 5, name: 'Pedro Sánchez',   code: 'AG-005', shifts: ['morning'],             airline: 'FR' },
      { id: 6, name: 'Laura Fernández', code: 'AG-006', shifts: ['night'],               airline: '' },
      { id: 7, name: 'Miguel Torres',   code: 'AG-007', shifts: ['morning','afternoon'], airline: 'UX' },
      { id: 8, name: 'Sofía Díaz',      code: 'AG-008', shifts: ['night'],               airline: '' },
    ],
    flights: [],
    assignments: {} // { [dateStr]: { [flightId]: agentId } }
  };
}

// ===== INIT =====
function init() {
  // Set default date
  const today = new Date();
  document.getElementById('currentDate').value = formatDateInput(today);

  // Seed demo flights if empty
  if (state.flights.length === 0) {
    seedDemoFlights();
  }

  // Load saved API key and backend URL
  const savedKey = localStorage.getItem('aeroshift_openai_key');
  if (savedKey && document.getElementById('openaiKey')) {
    document.getElementById('openaiKey').value = savedKey;
  }
  const savedUrl = localStorage.getItem('aeroshift_backend_url');
  const isHosted = window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1' && window.location.hostname !== '';

  if (document.getElementById('backendUrl')) {
    if (isHosted && (!savedUrl || savedUrl.includes('localhost') || savedUrl.includes('127.0.0.1'))) {
      document.getElementById('backendUrl').value = 'https://aeroshift-backend.onrender.com';
      localStorage.setItem('aeroshift_backend_url', 'https://aeroshift-backend.onrender.com');
    } else if (savedUrl) {
      document.getElementById('backendUrl').value = savedUrl;
    } else if (isHosted) {
      document.getElementById('backendUrl').value = 'https://aeroshift-backend.onrender.com';
    }
  }

  const savedOptModo = localStorage.getItem('aeroshift_opt_modo') || '';
  const optModoElement = document.getElementById('optModo');
  if (optModoElement) optModoElement.value = savedOptModo;

  // Pre-render the preview tables so they are ready on load!
  renderDetectedAgents();
  renderDetectedFlights();

  renderAll();
}

function saveOptModo(val) {
  localStorage.setItem('aeroshift_opt_modo', val);
}

function openValidationParametersModal() {
  const modal = document.getElementById('validationParametersModal');
  const optModo = document.getElementById('optModo');
  if (!modal || !optModo) return;
  const savedValue = localStorage.getItem('aeroshift_opt_modo') || optModo.value || '';
  optModo.value = savedValue;
  validationParametersSnapshot = { optModo: savedValue };
  modal.classList.add('active');
}

function cancelValidationParameters(event) {
  if (event && event.target !== event.currentTarget) return;
  const modal = document.getElementById('validationParametersModal');
  const optModo = document.getElementById('optModo');
  if (optModo && validationParametersSnapshot) {
    optModo.value = validationParametersSnapshot.optModo || '';
  }
  if (modal) modal.classList.remove('active');
  validationParametersSnapshot = null;
}

function saveValidationParameters() {
  const modal = document.getElementById('validationParametersModal');
  const optModo = document.getElementById('optModo');
  if (!optModo || !optModo.value) {
    alert('Selecciona una estrategia para el optimizador.');
    return;
  }
  saveOptModo(optModo.value);
  validationParametersSnapshot = null;
  if (modal) modal.classList.remove('active');
}

function seedDemoFlights() {
  const date = document.getElementById('currentDate').value;
  const demoFlights = [
    { id: 1, airline: 'IB',  number: 'IB3214', time: '06:30', gate: 'B23', destination: 'LHR',  pax: 180, type: 'departure' },
    { id: 2, airline: 'VY',  number: 'VY1234', time: '07:00', gate: 'A12', destination: 'FCO',  pax: 165, type: 'departure' },
    { id: 3, airline: 'IB',  number: 'IB576',  time: '07:45', gate: 'C05', destination: 'MIA',  pax: 90,  type: 'departure' }, // Low Pax <= 100
    { id: 4, airline: 'FR',  number: 'FR8321', time: '08:15', gate: 'D14', destination: 'STN',  pax: 189, type: 'departure' },
    { id: 5, airline: 'UX',  number: 'UX1023', time: '08:50', gate: 'B08', destination: 'BOG',  pax: 250, type: 'departure' },
    { id: 6, airline: 'LH',  number: 'LH1802', time: '09:20', gate: 'C12', destination: 'FRA',  pax: 140, type: 'departure' },
    { id: 7, airline: 'AF',  number: 'AF1081', time: '09:55', gate: 'A03', destination: 'CDG',  pax: 75,  type: 'departure' }, // Low Pax <= 100
    { id: 8, airline: 'IB',  number: 'IB3222', time: '14:30', gate: 'B30', destination: 'AMS',  pax: 180, type: 'departure' },
    { id: 9, airline: 'VY',  number: 'VY5501', time: '15:00', gate: 'A08', destination: 'PMI',  pax: 150, type: 'departure' },
    { id: 10, airline: 'BA', number: 'BA458',  time: '15:30', gate: 'C20', destination: 'LHR',  pax: 85,  type: 'departure' }, // Low Pax <= 100
    { id: 11, airline: 'TK', number: 'TK1858', time: '16:15', gate: 'D02', destination: 'IST',  pax: 200, type: 'departure' },
    { id: 12, airline: 'EW', number: 'EW9501', time: '17:00', gate: 'B16', destination: 'DUS',  pax: 120, type: 'departure' },
    { id: 13, airline: 'IB', number: 'IB6251', time: '22:30', gate: 'A15', destination: 'MEX',  pax: 240, type: 'departure' },
    { id: 14, airline: 'UX', number: 'UX55',   time: '23:15', gate: 'C08', destination: 'EZE',  pax: 280, type: 'departure' },
    { id: 15, airline: 'IB', number: 'IB3201', time: '07:20', gate: 'B10', destination: 'MAD',  pax: 150, type: 'arrival' },
    { id: 16, airline: 'FR', number: 'FR8322', time: '14:45', gate: 'D18', destination: 'STN',  pax: 189, type: 'arrival' },
  ];
  state.flights = demoFlights;

  // Seed some assignments
  state.assignments[date] = {
    1: 1, 2: 5, 3: 2, 4: 7, 5: 1, 6: 2,
    8: 3, 9: 4, 10: 7, 11: 3,
    13: 6, 14: 8
  };

  saveData();
}

// ===== RENDER ALL =====
function renderAll() {
  renderAgents();
  renderFlights();
  renderSchedule();
  updateStats();
}

// ===== RENDER AGENTS =====
function renderAgents() {
  const container = document.getElementById('agentList');
  
  if (state.agents.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4-4v2"/><circle cx="9" cy="7" r="4"/>
        </svg>
        <p>Sin agentes</p>
        <small>Pulsa + para añadir</small>
      </div>`;
    return;
  }

  container.innerHTML = state.agents.map((agent, i) => {
    const color = AVATAR_COLORS[i % AVATAR_COLORS.length];
    const initials = agent.name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
    const shiftDots = agent.shifts.map(s => 
      `<span class="agent-shift-badge dot-${s}"></span>`
    ).join('');

    return `
      <div class="agent-card" data-agent-id="${agent.id}">
        <div class="agent-avatar" style="background:${color}">${initials}</div>
        <div class="agent-info">
          <div class="agent-name">${escapeHtml(agent.name)}</div>
          <div class="agent-code">${escapeHtml(agent.code)}${agent.airline ? ' · ' + agent.airline : ''}</div>
        </div>
        <div class="agent-shifts">${shiftDots}</div>
        <div class="agent-actions">
          <button class="agent-action-btn" onclick="editAgent(${agent.id})" title="Editar">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="agent-action-btn delete" onclick="deleteAgent(${agent.id})" title="Eliminar">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
          </button>
        </div>
      </div>`;
  }).join('');
}

// ===== RENDER FLIGHTS =====
function renderFlights() {
  const container = document.getElementById('flightList');
  const date = document.getElementById('currentDate').value;
  const assignments = state.assignments[date] || {};
  const dateFlights = getFlightsForDate();

  if (dateFlights.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M17.8 19.2L16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.4-.1.8.3 1.1L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.7.5 1.1.3l.5-.3c.4-.2.5-.6.5-1.1z"/></svg>
        <p>Sin embarques</p>
        <small>Pulsa + para añadir vuelos</small>
      </div>`;
    return;
  }

  // Sort by time
  const sorted = [...dateFlights].sort((a, b) => a.time.localeCompare(b.time));

  container.innerHTML = sorted.map(flight => {
    const assignedAgentId = assignments[flight.id];
    const agent = assignedAgentId ? state.agents.find(a => a.id === assignedAgentId) : null;
    const isAssigned = !!agent;
    const airlineColor = AIRLINE_COLORS[flight.airline] || AIRLINE_COLORS.OTHER;

    return `
      <div class="flight-card ${isAssigned ? 'assigned' : ''}" 
           draggable="true"
           ondragstart="onFlightDragStart(event, ${flight.id})"
           ondragend="onFlightDragEnd(event)"
           onclick="openAssignModal(${flight.id})">
        <div class="flight-actions">
          <button class="flight-action-btn" onclick="event.stopPropagation(); editFlight(${flight.id})" title="Editar">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="flight-action-btn delete" onclick="event.stopPropagation(); deleteFlight(${flight.id})" title="Eliminar">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
          </button>
        </div>
        <div class="flight-card-header">
          <span class="flight-number">${escapeHtml(flight.number)}</span>
          <span class="flight-time">${flight.time}</span>
        </div>
        <div class="flight-details">
          <span class="flight-airline-badge" style="background:${airlineColor}">${flight.airline}</span>
          <span class="flight-gate">🚪 ${escapeHtml(flight.gate)}</span>
          <span class="flight-dest">${escapeHtml(flight.destination)}</span>
          <span class="flight-type-badge ${flight.type}">${flight.type === 'departure' ? 'SAL' : 'LLE'}</span>
        </div>
        ${isAssigned ? `
          <div class="flight-assigned-agent">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4-4v2"/><circle cx="12" cy="7" r="4"/></svg>
            ${escapeHtml(agent.name)}
          </div>
        ` : ''}
      </div>`;
  }).join('');
}

// ===== RENDER SCHEDULE =====
function renderSchedule() {
  const date = document.getElementById('currentDate').value;
  const assignments = state.assignments[date] || {};
  
  // Get agents filtered by shift
  let agents = getAgentsForShift(currentShiftFilter);
  
  // Build time slots: 30-minute intervals for 24h
  const slots = [];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 30) {
      slots.push({
        hour: h,
        minute: m,
        label: `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`,
        isHour: m === 0
      });
    }
  }

  // Get date flights
  const dateFlights = getFlightsForDate();

  // Header
  const thead = document.getElementById('scheduleHead');
  thead.innerHTML = `
    <tr>
      <th>Agente</th>
      ${slots.map(slot => `
        <th class="${slot.isHour ? 'hour-mark' : ''}" title="${slot.label}">
          ${slot.isHour ? slot.label : '·'}
        </th>
      `).join('')}
    </tr>`;

  // Body
  const tbody = document.getElementById('scheduleBody');
  
  if (agents.length === 0 && dateFlights.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="${slots.length + 1}" style="text-align:center; padding:60px; color:var(--text-muted)">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" style="margin-bottom:12px;opacity:0.3">
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
          </svg>
          <br>Añade agentes y embarques para ver la parrilla
        </td>
      </tr>`;
    return;
  }

  let rows = '';

  // Agent rows
  agents.forEach((agent, idx) => {
    const color = AVATAR_COLORS[state.agents.indexOf(agent) % AVATAR_COLORS.length];
    const initials = agent.name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
    const agentFlights = getAgentFlightsForDate(agent.id, date);
    const shiftInfo = agent.shifts.map(s => SHIFTS[s].label).join('/');

    let cells = '';
    slots.forEach((slot, slotIdx) => {
      const flight = agentFlights.find(f => {
        const [fh, fm] = f.time.split(':').map(Number);
        return fh === slot.hour && fm === slot.minute;
      });

      if (flight) {
        const airlineColor = AIRLINE_COLORS[flight.airline] || AIRLINE_COLORS.OTHER;
        cells += `
          <td class="has-flight">
            <div class="cell-flight" onclick="openAssignModal(${flight.id})" 
                 style="border-color:${airlineColor}40; background:${airlineColor}15"
                 title="${flight.number} — ${flight.gate} — ${flight.destination}">
              <span class="cell-flight-code" style="color:${airlineColor}">${flight.number}</span>
              <span class="cell-flight-gate">${flight.gate}</span>
            </div>
          </td>`;
      } else {
        cells += `<td class="drop-target" 
                      ondragover="onCellDragOver(event)" 
                      ondrop="onCellDrop(event, ${agent.id}, '${slot.label}')"
                      onclick="onCellClick(${agent.id}, '${slot.label}')"></td>`;
      }
    });

    rows += `
      <tr data-agent-id="${agent.id}">
        <td>
          <div class="td-agent">
            <div class="td-agent-avatar" style="background:${color}">${initials}</div>
            <div class="td-agent-info">
              <div class="td-agent-name">${escapeHtml(agent.name)}</div>
              <div class="td-agent-shift">${shiftInfo} · ${agent.code}</div>
            </div>
          </div>
        </td>
        ${cells}
      </tr>`;
  });

  // Unassigned flights row
  const unassignedFlights = dateFlights.filter(f => !assignments[f.id]);
  if (unassignedFlights.length > 0) {
    let unassignedCells = '';
    slots.forEach(slot => {
      const flight = unassignedFlights.find(f => {
        const [fh, fm] = f.time.split(':').map(Number);
        return fh === slot.hour && fm === slot.minute;
      });

      if (flight) {
        const airlineColor = AIRLINE_COLORS[flight.airline] || AIRLINE_COLORS.OTHER;
        unassignedCells += `
          <td class="has-flight">
            <div class="cell-flight" onclick="openAssignModal(${flight.id})"
                 style="border-color:${airlineColor}40; background:${airlineColor}15; border: 1px dashed var(--danger);">
              <span class="cell-flight-code" style="color:var(--danger)">${flight.number}</span>
              <span class="cell-flight-gate">⚠ Sin asignar</span>
            </div>
          </td>`;
      } else {
        unassignedCells += `<td></td>`;
      }
    });

    rows += `
      <tr class="unassigned-row">
        <td>
          <div class="td-agent">
            <div class="td-agent-avatar" style="background:var(--danger)">!</div>
            <div class="td-agent-info">
              <div class="td-agent-name" style="color:var(--danger)">Sin asignar</div>
              <div class="td-agent-shift">${unassignedFlights.length} embarque(s)</div>
            </div>
          </div>
        </td>
        ${unassignedCells}
      </tr>`;
  }

  tbody.innerHTML = rows;

  // Auto-scroll to first flight
  scrollToFirstFlight(dateFlights, slots);
}

function scrollToFirstFlight(flights, slots) {
  if (flights.length === 0) return;
  
  const sorted = [...flights].sort((a, b) => a.time.localeCompare(b.time));
  const firstTime = sorted[0].time;
  const [fh, fm] = firstTime.split(':').map(Number);
  const slotIndex = slots.findIndex(s => s.hour === fh && s.minute === fm);
  
  if (slotIndex > 0) {
    const container = document.getElementById('scheduleContainer');
    const cellWidth = 55; // approx
    const scrollTarget = Math.max(0, (slotIndex - 2) * cellWidth + 180);
    setTimeout(() => {
      container.parentElement.scrollLeft = scrollTarget;
    }, 100);
  }
}

// ===== FILTERS =====
function getAgentsForShift(shift) {
  if (shift === 'all') return [...state.agents];
  return state.agents.filter(a => a.shifts.includes(shift));
}

function getFlightsForDate() {
  // All flights (we use the same flights for demo, in real app would filter by date)
  return state.flights;
}

function getAgentFlightsForDate(agentId, date) {
  const assignments = state.assignments[date] || {};
  const flightIds = Object.entries(assignments)
    .filter(([_, aId]) => aId === agentId)
    .map(([fId]) => parseInt(fId));
  
  return state.flights.filter(f => flightIds.includes(f.id));
}

function filterShift(shift, btn) {
  currentShiftFilter = shift;
  document.querySelectorAll('.shift-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  renderSchedule();
  updateStats();
}

// ===== DRAG & DROP =====
function onFlightDragStart(e, flightId) {
  dragData = { flightId };
  e.dataTransfer.effectAllowed = 'move';
  e.target.classList.add('dragging');
}

function onFlightDragEnd(e) {
  e.target.classList.remove('dragging');
  dragData = null;
}

function onCellDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  e.currentTarget.classList.add('drop-target');
}

function onCellDrop(e, agentId, timeSlot) {
  e.preventDefault();
  e.currentTarget.classList.remove('drop-target');
  
  if (!dragData) return;
  
  const date = document.getElementById('currentDate').value;
  if (!state.assignments[date]) state.assignments[date] = {};
  
  // Assign flight to agent
  state.assignments[date][dragData.flightId] = agentId;
  
  saveData();
  renderAll();
}

// Click on empty cell to quick-assign
function onCellClick(agentId, timeSlot) {
  const date = document.getElementById('currentDate').value;
  const assignments = state.assignments[date] || {};
  
  // Find unassigned flights near this time slot
  const [h, m] = timeSlot.split(':').map(Number);
  const unassigned = state.flights.filter(f => {
    if (assignments[f.id]) return false;
    const [fh, fm] = f.time.split(':').map(Number);
    return fh === h && Math.abs(fm - m) <= 30;
  });

  if (unassigned.length === 1) {
    // Auto-assign if only one unassigned flight at this time
    if (!state.assignments[date]) state.assignments[date] = {};
    state.assignments[date][unassigned[0].id] = agentId;
    saveData();
    renderAll();
  } else if (unassigned.length > 1) {
    // Show assignment modal for this flight
    openAssignModalForAgent(agentId, unassigned);
  }
}

// ===== MODALS =====
function openModal(id) {
  document.getElementById(id).classList.add('active');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('active');
  // Reset forms
  if (id === 'agentModal') resetAgentForm();
  if (id === 'flightModal') resetFlightForm();
}

// Close modal on overlay click
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal-overlay')) {
    e.target.classList.remove('active');
  }
});

// ===== AGENT CRUD =====
function resetAgentForm() {
  document.getElementById('agentId').value = '';
  document.getElementById('agentName').value = '';
  document.getElementById('agentCode').value = '';
  document.getElementById('agentMorning').checked = true;
  document.getElementById('agentAfternoon').checked = false;
  document.getElementById('agentNight').checked = false;
  document.getElementById('agentAirline').value = '';
  document.getElementById('agentModalTitle').textContent = 'Nuevo Agente';
}

function saveAgent() {
  const id = document.getElementById('agentId').value;
  const name = document.getElementById('agentName').value.trim();
  const code = document.getElementById('agentCode').value.trim();
  const shifts = [];
  if (document.getElementById('agentMorning').checked) shifts.push('morning');
  if (document.getElementById('agentAfternoon').checked) shifts.push('afternoon');
  if (document.getElementById('agentNight').checked) shifts.push('night');
  const airline = document.getElementById('agentAirline').value;

  if (!name) { alert('El nombre es obligatorio'); return; }
  if (!code) { alert('El código es obligatorio'); return; }
  if (shifts.length === 0) { alert('Selecciona al menos un turno'); return; }

  if (id) {
    // Edit
    const agent = state.agents.find(a => a.id === parseInt(id));
    if (agent) {
      agent.name = name;
      agent.code = code;
      agent.shifts = shifts;
      agent.airline = airline;
    }
  } else {
    // Create
    const maxId = state.agents.reduce((max, a) => Math.max(max, a.id), 0);
    state.agents.push({ id: maxId + 1, name, code, shifts, airline });
  }

  saveData();
  closeModal('agentModal');
  renderAll();
}

function editAgent(id) {
  const agent = state.agents.find(a => a.id === id);
  if (!agent) return;

  document.getElementById('agentId').value = agent.id;
  document.getElementById('agentName').value = agent.name;
  document.getElementById('agentCode').value = agent.code;
  document.getElementById('agentMorning').checked = agent.shifts.includes('morning');
  document.getElementById('agentAfternoon').checked = agent.shifts.includes('afternoon');
  document.getElementById('agentNight').checked = agent.shifts.includes('night');
  document.getElementById('agentAirline').value = agent.airline || '';
  document.getElementById('agentModalTitle').textContent = 'Editar Agente';
  
  openModal('agentModal');
}

function deleteAgent(id) {
  if (!confirm('¿Eliminar este agente?')) return;
  state.agents = state.agents.filter(a => a.id !== id);
  
  // Remove assignments
  Object.keys(state.assignments).forEach(date => {
    Object.keys(state.assignments[date]).forEach(fId => {
      if (state.assignments[date][fId] === id) {
        delete state.assignments[date][fId];
      }
    });
  });

  saveData();
  renderAll();
}

// ===== FLIGHT CRUD =====
function resetFlightForm() {
  document.getElementById('flightId').value = '';
  document.getElementById('flightAirline').value = 'IB';
  document.getElementById('flightNumber').value = '';
  document.getElementById('flightTime').value = '';
  document.getElementById('flightGate').value = '';
  document.getElementById('flightDestination').value = '';
  document.getElementById('flightType').value = 'departure';
  document.getElementById('flightModalTitle').textContent = 'Nuevo Embarque';
}

function saveFlight() {
  const id = document.getElementById('flightId').value;
  const airline = document.getElementById('flightAirline').value;
  const number = document.getElementById('flightNumber').value.trim();
  const time = document.getElementById('flightTime').value;
  const gate = document.getElementById('flightGate').value.trim();
  const destination = document.getElementById('flightDestination').value.trim();
  const type = document.getElementById('flightType').value;

  if (!number) { alert('El nº de vuelo es obligatorio'); return; }
  if (!time) { alert('La hora es obligatoria'); return; }
  if (!gate) { alert('La puerta/stand es obligatorio'); return; }

  if (id) {
    const flight = state.flights.find(f => f.id === parseInt(id));
    if (flight) {
      Object.assign(flight, { airline, number, time, gate, destination, type });
    }
  } else {
    const maxId = state.flights.reduce((max, f) => Math.max(max, f.id), 0);
    state.flights.push({ id: maxId + 1, airline, number, time, gate, destination, type });
  }

  saveData();
  closeModal('flightModal');
  renderAll();
}

function editFlight(id) {
  const flight = state.flights.find(f => f.id === id);
  if (!flight) return;

  document.getElementById('flightId').value = flight.id;
  document.getElementById('flightAirline').value = flight.airline;
  document.getElementById('flightNumber').value = flight.number;
  document.getElementById('flightTime').value = flight.time;
  document.getElementById('flightGate').value = flight.gate;
  document.getElementById('flightDestination').value = flight.destination;
  document.getElementById('flightType').value = flight.type;
  document.getElementById('flightModalTitle').textContent = 'Editar Embarque';

  openModal('flightModal');
}

function deleteFlight(id) {
  if (!confirm('¿Eliminar este embarque?')) return;
  state.flights = state.flights.filter(f => f.id !== id);
  
  // Remove assignments
  Object.keys(state.assignments).forEach(date => {
    delete state.assignments[date][id];
  });

  saveData();
  renderAll();
}

// ===== ASSIGN MODAL =====
function openAssignModal(flightId) {
  const flight = state.flights.find(f => f.id === flightId);
  if (!flight) return;

  const date = document.getElementById('currentDate').value;
  const assignments = state.assignments[date] || {};
  const currentAgentId = assignments[flightId];

  // Info
  document.getElementById('assignFlightInfo').innerHTML = 
    `<strong>${flight.number}</strong> · ${flight.time} · 🚪 ${flight.gate} · ${flight.destination}`;

  // Available agents
  const shiftForTime = getShiftForTime(flight.time);
  const availableAgents = state.agents.filter(a => a.shifts.includes(shiftForTime));
  
  const list = document.getElementById('assignAgentList');
  
  if (availableAgents.length === 0) {
    list.innerHTML = `
      <div class="empty-state" style="padding:20px">
        <p>No hay agentes para este turno (${SHIFTS[shiftForTime].label})</p>
      </div>`;
  } else {
    list.innerHTML = availableAgents.map((agent, i) => {
      const color = AVATAR_COLORS[state.agents.indexOf(agent) % AVATAR_COLORS.length];
      const initials = agent.name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
      const agentFlightCount = getAgentFlightsForDate(agent.id, date).length;
      const isCurrentAssignment = currentAgentId === agent.id;
      const isAlreadyAssigned = Object.values(assignments).includes(agent.id) && !isCurrentAssignment;
      
      return `
        <div class="assign-agent-item ${isCurrentAssignment ? '' : ''}" 
             onclick="assignFlightToAgent(${flightId}, ${agent.id})">
          <div class="agent-avatar" style="background:${color}">${initials}</div>
          <div class="agent-info">
            <div class="agent-name">${escapeHtml(agent.name)}</div>
            <div class="agent-code">${agent.code} · ${agentFlightCount} vuelo(s)</div>
          </div>
          ${isCurrentAssignment ? '<span class="agent-status available">✓ Actual</span>' :
            isAlreadyAssigned ? '<span class="agent-status busy">Ocupado</span>' :
            '<span class="agent-status available">Disponible</span>'}
        </div>`;
    }).join('');
  }

  // Show/hide unassign button
  const btnUnassign = document.getElementById('btnUnassign');
  btnUnassign.style.display = currentAgentId ? 'inline-flex' : 'none';
  
  // Store current flight id for unassign
  btnUnassign.dataset.flightId = flightId;

  openModal('assignModal');
}

function assignFlightToAgent(flightId, agentId) {
  const date = document.getElementById('currentDate').value;
  if (!state.assignments[date]) state.assignments[date] = {};
  state.assignments[date][flightId] = agentId;
  
  saveData();
  closeModal('assignModal');
  renderAll();
}

function unassignFlight() {
  const flightId = parseInt(document.getElementById('btnUnassign').dataset.flightId);
  const date = document.getElementById('currentDate').value;
  if (state.assignments[date]) {
    delete state.assignments[date][flightId];
  }
  
  saveData();
  closeModal('assignModal');
  renderAll();
}

function openAssignModalForAgent(agentId, flights) {
  // Quick assign: open modal showing these flights to pick
  if (flights.length > 0) {
    openAssignModal(flights[0].id);
  }
}

// ===== UTILITY =====
function getShiftForTime(time) {
  const [h] = time.split(':').map(Number);
  if (h >= 6 && h < 14) return 'morning';
  if (h >= 14 && h < 22) return 'afternoon';
  return 'night';
}

function formatDateInput(date) {
  return date.toISOString().split('T')[0];
}

function changeDate(offset) {
  const input = document.getElementById('currentDate');
  const date = new Date(input.value);
  date.setDate(date.getDate() + offset);
  input.value = formatDateInput(date);
  renderSchedule();
}

function setToday() {
  document.getElementById('currentDate').value = formatDateInput(new Date());
  renderSchedule();
}

function updateStats() {
  const date = document.getElementById('currentDate').value;
  const assignments = state.assignments[date] || {};
  const dateFlights = getFlightsForDate();
  const assignedCount = Object.keys(assignments).filter(fId => 
    dateFlights.some(f => f.id === parseInt(fId))
  ).length;
  
  const activeAgents = new Set(Object.values(assignments)).size;

  document.getElementById('statAgents').textContent = activeAgents;
  document.getElementById('statAssigned').textContent = assignedCount;
  document.getElementById('statUnassigned').textContent = dateFlights.length - assignedCount;
  document.getElementById('statFlights').textContent = dateFlights.length;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ===== EXPORT =====
function exportCSV() {
  const date = document.getElementById('currentDate').value;
  const assignments = state.assignments[date] || {};
  
  let csv = 'Agente,Código,Turno,Vuelo,Hora,Puerta,Aerolínea,Destino,Tipo\n';
  
  state.agents.forEach(agent => {
    const agentFlights = getAgentFlightsForDate(agent.id, date);
    const shiftLabel = agent.shifts.map(s => SHIFTS[s].label).join('/');
    
    if (agentFlights.length === 0) {
      csv += `"${agent.name}","${agent.code}","${shiftLabel}","","","","","",""\n`;
    } else {
      agentFlights.forEach(f => {
        csv += `"${agent.name}","${agent.code}","${shiftLabel}","${f.number}","${f.time}","${f.gate}","${f.airline}","${f.destination}","${f.type === 'departure' ? 'Salida' : 'Llegada'}"\n`;
      });
    }
  });

  // Unassigned
  const unassigned = state.flights.filter(f => !assignments[f.id]);
  unassigned.forEach(f => {
    csv += `"SIN ASIGNAR","","","${f.number}","${f.time}","${f.gate}","${f.airline}","${f.destination}","${f.type === 'departure' ? 'Salida' : 'Llegada'}"\n`;
  });

  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `aeroshift_parrilla_${date}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ===== KEYBOARD SHORTCUTS =====
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active'));
  }
});

// ===== START =====
try {
  init();
} catch (err) {
  alert("Error en la inicialización (init): " + err.message + "\nStack: " + err.stack);
}

// ==========================================
// VIEW SWITCHER
// ==========================================
function switchView(view) {
  const viewInicio = document.getElementById('viewInicio');
  const viewMetodoCreacion = document.getElementById('viewMetodoCreacion');
  const viewExtractorPreview = document.getElementById('viewExtractorPreview');
  const viewParrilla = document.getElementById('viewParrilla');
  const viewIA = document.getElementById('viewIA');
  const tabParrilla = document.getElementById('tabParrilla');
  const tabIA = document.getElementById('tabIA');

  if (view === 'inicio') {
    if (viewInicio) viewInicio.style.display = 'flex';
    if (viewMetodoCreacion) viewMetodoCreacion.style.display = 'none';
    if (viewExtractorPreview) viewExtractorPreview.style.display = 'none';
    if (viewParrilla) viewParrilla.style.display = 'none';
    if (viewIA) viewIA.style.display = 'none';
    if (tabParrilla) tabParrilla.classList.remove('active');
    if (tabIA) tabIA.classList.remove('active');
  } else if (view === 'metodo-creacion') {
    if (viewInicio) viewInicio.style.display = 'none';
    if (viewMetodoCreacion) viewMetodoCreacion.style.display = 'flex';
    if (viewExtractorPreview) viewExtractorPreview.style.display = 'none';
    if (viewParrilla) viewParrilla.style.display = 'none';
    if (viewIA) viewIA.style.display = 'none';
    if (tabParrilla) tabParrilla.classList.remove('active');
    if (tabIA) tabIA.classList.remove('active');
  } else if (view === 'extractor-preview') {
    if (viewInicio) viewInicio.style.display = 'none';
    if (viewMetodoCreacion) viewMetodoCreacion.style.display = 'none';
    if (viewExtractorPreview) viewExtractorPreview.style.display = 'flex';
    if (viewParrilla) viewParrilla.style.display = 'none';
    if (viewIA) viewIA.style.display = 'none';
    if (tabParrilla) tabParrilla.classList.remove('active');
    if (tabIA) tabIA.classList.remove('active');
  } else if (view === 'parrilla') {
    if (viewInicio) viewInicio.style.display = 'none';
    if (viewMetodoCreacion) viewMetodoCreacion.style.display = 'none';
    if (viewExtractorPreview) viewExtractorPreview.style.display = 'none';
    if (viewParrilla) viewParrilla.style.display = 'flex';
    if (viewIA) viewIA.style.display = 'none';
    if (tabParrilla) tabParrilla.classList.add('active');
    if (tabIA) tabIA.classList.remove('active');
    renderAll(); // Refresh the grid
  } else if (view === 'ia') {
    if (viewInicio) viewInicio.style.display = 'none';
    if (viewMetodoCreacion) viewMetodoCreacion.style.display = 'none';
    if (viewExtractorPreview) viewExtractorPreview.style.display = 'none';
    if (viewParrilla) viewParrilla.style.display = 'none';
    if (viewIA) viewIA.style.display = 'flex';
    if (tabParrilla) tabParrilla.classList.remove('active');
    if (tabIA) tabIA.classList.add('active');
  }
}

// ==========================================
// FILE UPLOAD HANDLER (IA EXTRACTOR WITH VISION BACKEND CONNECTION)
// ==========================================
// ==========================================
// FILE UPLOAD HANDLER (WEB 3 HIGH-FIDELITY DESIGN WITH DUAL SCROLL RECTANGLES)
// ========================================== 

async function uploadFileToBackend(files, type) {
  if (!files || files.length === 0) return;

  const modal = document.getElementById('processingModal');
  const title = document.getElementById('procTitle');
  const sub = document.getElementById('procSub');
  const progress = document.getElementById('procProgress');
  const status = document.getElementById('procStatus');
  const openaiKey = localStorage.getItem('aeroshift_openai_key') || '';
  const backendInput = document.getElementById('backendUrl');
  const backendUrl = backendInput ? backendInput.value.trim() : 'http://localhost:8000';
  const backendModelInput = document.getElementById('backendModel');
  const selectedModel = backendModelInput ? backendModelInput.value : 'gpt-5.6-luna';

  if (!modal) return;

  // Setup file list copies for preview tags
  const filesCopy = [];
  for (let i = 0; i < files.length; i++) {
    filesCopy.push({
      name: files[i].name,
      blobUrl: URL.createObjectURL(files[i])
    });
  }

  // Reset progress bar & texts
  progress.style.width = '0%';
  status.textContent = 'PROCESANDO 0%';
  
  if (filesCopy.length === 1) {
    title.textContent = 'Analizando ' + filesCopy[0].name + '...';
  } else {
    title.textContent = 'Analizando ' + filesCopy.length + ' archivos seleccionados...';
  }
  sub.textContent = 'Conectando con el motor de Visión de AeroShift...';

  modal.classList.add('active');

  // Progreso estimado: la API no comunica un porcentaje real mientras trabaja.
  // Avanza hasta el 90% en 65 segundos y después lentamente hasta el 95%.
  let currentPercent = 0;
  const progressStartedAt = performance.now();
  const stages = [
    { p: 15, msg: 'Conectando con el motor de Visión de AeroShift...' },
    { p: 45, msg: 'Escaneando imágenes y detectando texto...' },
    { p: 70, msg: 'Procesando tablas...' },
    { p: 90, msg: 'Estructurando y verificando los datos extraídos...' },
    { p: 95, msg: 'Esperando la respuesta final del modelo de inteligencia artificial...' }
  ];

  const renderEstimatedProgress = () => {
    progress.style.width = currentPercent.toFixed(2) + '%';
    status.textContent = 'PROCESANDO ' + Math.floor(currentPercent) + '%';
    const stage = stages.find(stageItem => currentPercent <= stageItem.p);
    if (stage) sub.textContent = stage.msg;
  };

  const interval = setInterval(() => {
    const elapsed = performance.now() - progressStartedAt;
    if (elapsed <= 65000) {
      currentPercent = Math.min(90, (elapsed / 65000) * 90);
    } else {
      const slowPhase = Math.min(1, (elapsed - 65000) / 145000);
      currentPercent = 90 + slowPhase * 5;
    }
    renderEstimatedProgress();
  }, 250);

  const completeProgressQuickly = () => {
    clearInterval(interval);
    const initialPercent = currentPercent;
    const animationStartedAt = performance.now();
    const animationDuration = 450;
    const animate = (now) => {
      const ratio = Math.min(1, (now - animationStartedAt) / animationDuration);
      const eased = 1 - Math.pow(1 - ratio, 3);
      currentPercent = initialPercent + (100 - initialPercent) * eased;
      progress.style.width = currentPercent.toFixed(2) + '%';
      status.textContent = 'PROCESANDO ' + Math.floor(currentPercent) + '%';
      if (ratio < 1) {
        requestAnimationFrame(animate);
      } else {
        currentPercent = 100;
        progress.style.width = '100%';
        status.textContent = 'PROCESANDO 100%';
      }
    };
    requestAnimationFrame(animate);
  };

  // Prepare FormData payload for the backend API
  const formData = new FormData();
  for (let i = 0; i < files.length; i++) {
    formData.append('files', files[i]);
  }

  // Límite máximo visible para una extracción con doble revisión: tres minutos y medio.
  const extractionController = new AbortController();
  const extractionTimeoutId = setTimeout(() => {
    extractionController.abort();
  }, 210000);

  try {
    const response = await fetch(`${backendUrl}/extract?model=${selectedModel}&type=${type}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiKey}`
      },
      body: formData,
      signal: extractionController.signal
    });

    if (!response.ok) {
      throw new Error(`Error en el servidor de extracción: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    clearTimeout(extractionTimeoutId);
    if (data.success) {
      // Inicializa y migra la estructura con fechas independientes.
      ensureExtractedDataShape();

      // 1. Process agents if type is "agents" (or both if type is not specified)
      if (type === 'agents' || type === 'all') {
        const newAgents = data.agents.map((a, idx) => {
          return {
            id: a.id || (idx + 1),
            name: a.name || 'Agente',
            hours: a.hours || '08:00-16:00',
            role: a.role || 'CSA',
            type: a.type || 'pasaje',
            shift: a.shift || 'mañana',
            espec: a.espec || [],
            excluir: a.excluir || false,
            source_row_people: Math.max(1, Number(a.source_row_people || 1)),
            validation_errors: Array.isArray(a.validation_errors) ? a.validation_errors : []
          };
        });
        extractedData.agents = newAgents;
      }

      // 2. Process flights if type is "flights" or "all" (accumulates flights programmatically!)
      if (type === 'flights' || type === 'all') {
        const currentLength = (type === 'flights') ? extractedData.flights.length : 0;
        const newFlights = data.flights.map((f, index) => {
          return {
            id: f.id + currentLength, // Auto-increment ID to prevent duplicate key collisions!
            destination: f.destination ?? null,
            airline: f.airline ?? null,
            number: f.number ?? null,
            time: f.time ?? null,
            agents: '', // Always blank initially as requested
            pax: f.pax ?? null,
            validation_errors: []
          };
        });
        if (type === 'flights') {
          extractedData.flights = [...extractedData.flights, ...newFlights];
        } else {
          extractedData.flights = newFlights;
        }
      }

      // Cada cuadrante conserva exclusivamente la fecha de su propio archivo.
      const isDateValid = (d) => d && d !== 'Fecha no detectada' && d !== 'Sábado 20 Junio';
      const detectedDate = isDateValid(data.date)
        ? String(data.date).trim()
        : getTodayDisplayDate();
      if (type === 'agents') {
        // Los turnos sustituyen el cuadrante anterior: nunca heredan su fecha.
        extractedData.agentsDate = detectedDate;
      } else if (type === 'flights') {
        // Los vuelos pueden cargarse en páginas sucesivas sin fecha repetida.
        extractedData.flightsDate = isDateValid(data.date)
          ? String(data.date).trim()
          : (extractedData.flightsDate || getTodayDisplayDate());
      } else {
        extractedData.agentsDate = detectedDate;
        extractedData.flightsDate = detectedDate;
      }

      completeProgressQuickly();
      if (type === 'agents' && data.verification_completed === true) {
        const corrected = Number(data.verification_corrections || 0);
        const firstTime = Number(data.first_extraction_seconds || 0).toFixed(1);
        const verificationTime = Number(data.verification_seconds || 0).toFixed(1);
        const totalTime = Number(data.total_backend_seconds || 0).toFixed(1);
        sub.textContent = `Completado. Extracción: ${firstTime}s · Verificación: ${verificationTime}s · Total: ${totalTime}s · Correcciones: ${corrected}.`;
      } else {
        sub.textContent = '¡Análisis de Visión IA completado con éxito!';
      }

      setTimeout(() => {
        try {
          modal.classList.remove('active');
          
          // Accumulate the new files into our global array with their associated type!
          filesCopy.forEach(f => {
            uploadedFilesCopy.push({
              name: f.name,
              blobUrl: f.blobUrl,
              type: type
            });
          });

          // Populate the uploaded files list with accumulative previews!
          renderUploadedFilesList();

          // Render high fidelity flights and agents tables
          renderDetectedAgents();
          renderDetectedFlights();
          
          if (!data.is_real_ai) {
            alert(`Aviso del Servidor:\nLa extracción por IA no se completó.\n\nDetalle: Existen ciertos problemas de conexión con tu ordenador. Por favor, inténtalo nuevamente.`);
          } else if (type === 'agents' && Number(data.validation_issue_count || 0) > 0) {
            const verificationNote = data.verification_completed === false
              ? `\n\n${data.verification_warning || 'La segunda verificación no pudo completarse.'}`
              : '';
            alert(
              'Aviso: hay turnos pendientes de revisión.\n\n' +
              (data.validation_warning || 'Corrige las filas marcadas antes de importar.') +
              verificationNote
            );
          } else if (type === 'agents' && data.verification_completed === false) {
            alert(
              'Aviso de verificación:\n\n' +
              (data.verification_warning ||
                'La extracción principal se completó, pero no pudo finalizarse la segunda verificación de horarios. Revisa los horarios antes de importar.')
            );
          }
        } catch (err) {
          console.error("Defensive catch in upload success timer:", err);
          alert("Error de renderizado (Exito): " + err.message + "\nStack: " + err.stack);
        } finally {
          // ALWAYS SWITCH VIEW!
          switchView('extractor-preview');
        }
      }, 500);
    } else {
      throw new Error(data.message || 'El servicio de Visión no devolvió un set de datos de éxito.');
    }
  } catch (error) {
    clearTimeout(extractionTimeoutId);
    const displayedError = error && error.name === 'AbortError'
      ? new Error('La extracción superó el tiempo máximo de 3 minutos y 30 segundos.')
      : error;
    console.error('La extracción no se completó:', displayedError);

    clearInterval(interval);
    progress.style.width = '100%';
    status.textContent = 'ERROR DE EXTRACCIÓN';
    sub.textContent = displayedError.message || 'No se pudieron extraer los datos.';

    // No se cargan agentes ni vuelos ficticios. Conservamos intactos los
    // datos que el usuario ya tuviera antes de esta operación fallida.
    setTimeout(() => {
      modal.classList.remove('active');
      alert(
        'La extracción por IA no se completó.\n\n' +
        (displayedError.message || 'Error desconocido del servidor.')
      );
    }, 500);
  }
}

// Concrete upload handlers
function handleScheduleFileUpload(event) {
  uploadFileToBackend(event.target.files, 'all');
}

function handleAgentsFileUpload(event) {
  uploadFileToBackend(event.target.files, 'agents');
}

function handleFlightsFileUpload(event) {
  uploadFileToBackend(event.target.files, 'flights');
}

function tryUploadAgain() {
  const fileInput = document.getElementById('scheduleFileInput');
  if (fileInput) {
    fileInput.click();
  }
}

function validateUploadedData() {
  const optModoElem = document.getElementById('optModo');
  if (optModoElem && optModoElem.value === '') {
    alert('Abre “Parámetros de Validación” y selecciona una estrategia para el optimizador antes de importar los datos.');
    return;
  }

  if (extractedData && Array.isArray(extractedData.agents)) {
    const pendingAgents = [];
    extractedData.agents.forEach(agent => {
      agent.validation_errors = validateAgentForImport(agent);
      if (agent.validation_errors.length > 0) pendingAgents.push(agent);
    });
    if (pendingAgents.length > 0) {
      renderDetectedAgents();
      const details = pendingAgents.slice(0, 12).map(agent =>
        `- ${agent.name}: ${agent.validation_errors.join(' ')}`
      ).join('\n');
      const extra = pendingAgents.length > 12
        ? `\n- Y ${pendingAgents.length - 12} fila(s) más.`
        : '';
      alert(
        'No se pueden importar los turnos todavía.\n\n' +
        'Corrige las filas marcadas en rojo:\n' + details + extra
      );
      return;
    }
  }

  if (extractedData && Array.isArray(extractedData.flights)) {
    const pendingFlights = [];
    extractedData.flights.forEach(flight => {
      flight.validation_errors = validateFlightForImport(flight);
      if (flight.validation_errors.length > 0) pendingFlights.push(flight);
    });
    if (pendingFlights.length > 0) {
      renderDetectedFlights();
      const details = pendingFlights.slice(0, 12).map((flight, index) =>
        `- Vuelo ${flight.number || `fila ${index + 1}`}: ${flight.validation_errors.join(' ')}`
      ).join('\n');
      const extra = pendingFlights.length > 12
        ? `\n- Y ${pendingFlights.length - 12} vuelo(s) más.`
        : '';
      alert(
        'No se pueden importar los vuelos todavía.\n\n' +
        'Corrige las filas marcadas en rojo:\n' + details + extra
      );
      return;
    }
  }

  // Overwrite the daily flights list for simulation
  if (extractedData) {
    state.agents = normalizeAgents(extractedData.agents);
    state.flights = extractedData.flights.map((f) => {
      return {
        id: f.id,
        airline: f.airline || '',
        number: f.number,
        time: f.time, // STD
        gate: f.gate || '',
        destination: f.destination,
        pax: Number(f.pax),
        type: 'departure'
      };
    });
  } else {
    initializeMockExtractedData();
    state.flights = extractedData.flights.map((f) => {
      return {
        id: f.id,
        airline: f.airline,
        number: f.number,
        time: f.time,
        gate: f.gate || '',
        destination: f.destination,
        pax: f.pax === null || f.pax === undefined || f.pax === '' ? null : Number(f.pax),
        type: 'departure'
      };
    });
  }

  const date = document.getElementById('currentDate').value;
  state.assignments[date] = {}; 
  saveData();
  renderAll();

  // Redirect to daily visual schedule board (manual view)
  switchView('parrilla');

  setTimeout(() => {
    alert('¡Excelente!\nLos datos detectados por la IA se han cargado de forma impecable.\n\nTodos los vuelos importados aparecen en "Sin Asignar" en tu cuadrante de hoy. Puedes arrastrarlos manualmente a los agentes correspondientes, o pulsar "Asistente IA" en la cabecera para resolver toda la distribución usando OR-Tools en un clic.');
  }, 100);
}

function validateAgentForImport(agent) {
  const errors = [];
  const schedule = String(agent.hours || '').trim().replace(/–|—/g, '-').replace(/\/\//g, '/');
  const role = String(agent.role || agent.rol || '').trim().toUpperCase();
  const type = String(agent.type || '').trim().toLowerCase();
  const agentName = String(agent.name || '').trim();

  const normalizeNameKey = value => String(value || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const protectedCompoundNames = new Set(['MARIA JOSE', 'JOSE MARIA', 'JUAN CARLOS']);
  const isProtectedCompound = value => protectedCompoundNames.has(normalizeNameKey(value));
  const isAbbreviatedGivenName = token =>
    /^(?:[A-ZÁÉÍÓÚÜÑ](?:\.|\.?[ªº])|MA\.)$/i.test(String(token || '').trim());
  const countNameGroups = part => {
    const rawPart = String(part || '').trim();
    const tokens = rawPart.split(/\s+/).filter(Boolean);
    if (tokens.length <= 1 || isProtectedCompound(rawPart)) return tokens.length ? 1 : 0;

    const groups = [];
    let index = 0;
    while (index < tokens.length) {
      const token = tokens[index];

      if (groups.length > 0 && isAbbreviatedGivenName(token)) {
        groups[groups.length - 1].push(token);
        index += 1;
        continue;
      }

      if (index + 1 < tokens.length && isProtectedCompound(`${token} ${tokens[index + 1]}`)) {
        const group = [token, tokens[index + 1]];
        index += 2;
        while (index < tokens.length) {
          if (group.length > 2 && group[group.length - 1].endsWith('.')) break;
          const nextToken = tokens[index];
          const letters = nextToken.toUpperCase().replace(/[^A-ZÁÉÍÓÚÜÑ]/g, '');
          if (isAbbreviatedGivenName(nextToken) || letters.length >= 5) break;
          group.push(nextToken);
          index += 1;
        }
        groups.push(group);
        continue;
      }

      if (isAbbreviatedGivenName(token) && index + 1 < tokens.length) {
        const group = [token, tokens[index + 1]];
        index += 2;
        while (index < tokens.length) {
          if (group.length > 2 && group[group.length - 1].endsWith('.')) break;
          const nextToken = tokens[index];
          const letters = nextToken.toUpperCase().replace(/[^A-ZÁÉÍÓÚÜÑ]/g, '');
          if (isAbbreviatedGivenName(nextToken) || letters.length >= 5) break;
          group.push(nextToken);
          index += 1;
        }
        groups.push(group);
        continue;
      }

      if (groups.length > 0 && groups[groups.length - 1].length > 1 && groups[groups.length - 1].at(-1).endsWith('.')) {
        groups.push([token]);
        index += 1;
        continue;
      }

      const letters = token.toUpperCase().replace(/[^A-ZÁÉÍÓÚÜÑ]/g, '');
      if (groups.length === 0 || letters.length >= 5) groups.push([token]);
      else groups[groups.length - 1].push(token);
      index += 1;
    }
    return groups.length;
  };
  const explicitNameParts = agentName
    .split(/\s*(?:\/{1,2}|,|;|\+|-)\s*/)
    .filter(Boolean);
  const detectedNameGroups = explicitNameParts.reduce(
    (total, part) => total + countNameGroups(part), 0
  );
  if (detectedNameGroups > 1) {
    errors.push('Posible unión de varias personas en un solo nombre.');
  }

  if (!schedule || schedule.toUpperCase() === 'ILEGIBLE') {
    errors.push('Horario vacío o ilegible.');
    return errors;
  }

  const segments = schedule.split('/').map(s => s.trim()).filter(Boolean);
  if (segments.length < 1 || segments.length > 2) {
    errors.push('Formato de horario inválido.');
    return errors;
  }
  const sourceRowPeople = Math.max(1, Number(agent.source_row_people || 1));
  if (type === 'admin' && sourceRowPeople > 1 && segments.length > 1) {
    errors.push('La fila de oficina contiene varias personas; asigna un horario individual a cada una.');
  }

  let totalMinutes = 0;
  const pattern = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/;
  for (const segment of segments) {
    const match = segment.match(pattern);
    if (!match) {
      errors.push(`Formato de horario inválido: ${segment}.`);
      continue;
    }
    const sh = Number(match[1]);
    const sm = Number(match[2]);
    const eh = Number(match[3]);
    const em = Number(match[4]);
    if (sh > 23 || eh > 23 || sm > 59 || em > 59) {
      errors.push(`Hora fuera de rango: ${segment}.`);
      continue;
    }
    const start = sh * 60 + sm;
    let end = eh * 60 + em;
    if (end < start) end += 1440;
    const duration = end - start;
    if (duration <= 0) errors.push(`Tramo de duración nula: ${segment}.`);
    totalMinutes += Math.max(0, duration);
  }

  if (totalMinutes > 600) {
    errors.push(`Jornada superior a 10 horas (${totalMinutes} minutos).`);
  }
  if (!role) errors.push('Rol vacío o ilegible.');
  if (type === 'admin' && role.startsWith('CSA')) {
    errors.push('Un agente de oficina no puede tener rol CSA.');
  }
  return [...new Set(errors)];
}

// Render Agents Table
function renderDetectedAgents() {
  const container = document.getElementById('detectedAgentsBody');
  if (!container) return;

  ensureExtractedDataShape();

  const titleElem = document.getElementById('detectedAgentsTitle');
  if (titleElem) {
    const agentsDate = extractedData?.agentsDate || '';
    titleElem.innerHTML = agentsDate
      ? `👥 Turnos del Personal — ${escapeHtml(agentsDate)}`
      : '👥 Turnos del Personal';
  }

  // Helper to determine shift
  const getAgentShift = (a) => {
    if (a.shift) return a.shift.toLowerCase().trim();
    if (a.hours) {
      const startHour = parseInt(a.hours.split(':')[0], 10);
      if (isNaN(startHour)) return 'mañana';
      return startHour >= 12 ? 'tarde' : 'mañana';
    }
    return 'mañana';
  };

  // Filter agents into 4 distinct groups
  const mañanaAdmins = extractedData.agents.filter(a => a.type === 'admin' && getAgentShift(a) === 'mañana');
  const mañanaPasajes = extractedData.agents.filter(a => a.type === 'pasaje' && getAgentShift(a) === 'mañana');
  const tardeAdmins = extractedData.agents.filter(a => a.type === 'admin' && getAgentShift(a) === 'tarde');
  const tardePasajes = extractedData.agents.filter(a => a.type === 'pasaje' && getAgentShift(a) === 'tarde');

  let html = '';

  const renderAgentRow = (a) => {
    const isEditing = editingAgentId === a.id;
    if (isEditing) {
      return `
        <tr style="border-bottom: 1px solid #282828; background: #1a1a1a;">
          <td style="padding: 8px;"><input type="text" value="${escapeHtml(a.name)}" id="edit_agent_name_${a.id}" style="width: 100%; padding: 4px 6px; border: 1px solid var(--primary); border-radius: 4px; background: #000; color: #fff; font-family: inherit; font-size:12px; text-transform: uppercase;"></td>
          <td style="padding: 8px;"><input type="text" value="${escapeHtml(a.hours)}" id="edit_agent_hours_${a.id}" style="width: 100%; padding: 4px 6px; border: 1px solid var(--primary); border-radius: 4px; background: #000; color: #fff; font-family: inherit; font-size:12px;"></td>
          <td style="padding: 8px;"><input type="text" value="${escapeHtml(a.role)}" id="edit_agent_role_${a.id}" style="width: 100%; padding: 4px 6px; border: 1px solid var(--primary); border-radius: 4px; background: #000; color: #fff; font-family: inherit; font-size:12px; text-transform: uppercase;"></td>
          <td style="padding: 8px; text-align: center;" colspan="2">
            <span style="color:#666; font-size:11px; font-style:italic;">Editando...</span>
          </td>
          <td style="padding: 8px; text-align: center;">
            <div style="display: flex; gap: 6px; justify-content: center;">
              <button onclick="saveEditAgent(${a.id})" style="background: var(--success); color: white; border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; font-weight:700;">✓</button>
              <button onclick="cancelEditAgent()" style="background: var(--text-muted); color: white; border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; font-weight:700;">✗</button>
            </div>
          </td>
        </tr>`;
    } else {
      const validationErrors = Array.isArray(a.validation_errors) ? a.validation_errors : [];
      const hasValidationError = validationErrors.length > 0;
      const validationTitle = escapeHtml(validationErrors.join(' | ')).replace(/"/g, '&quot;');
      const rowStyle = hasValidationError
        ? 'border-bottom:1px solid #7f1d1d; background:rgba(239,68,68,0.13);'
        : 'border-bottom:1px solid #1f1f1f; transition:background 0.15s;';
      const hoverAttrs = hasValidationError
        ? ''
        : `onmouseover="this.style.background='#161616'" onmouseout="this.style.background='none'"`;
      const warningBadge = hasValidationError
        ? `<span title="${validationTitle}" style="color:#ef4444; margin-left:7px; font-weight:bold; cursor:help;">⚠ REVISAR</span>`
        : '';
      const especValue = (a.espec && a.espec.length > 0) ? a.espec[0] : '';
      // Only show the dropdown for non-admin agents (CSA pasajes)
      const selectHtml = a.type === 'admin' ? '<span style="color:#555;">—</span>' : `
        <select onchange="updateAgentEspec(${a.id}, this.value)" style="background: #000; color: #fff; border: 1px solid #333; border-radius: 4px; padding: 2px 4px; font-family: inherit; font-size: 11px; width: 75px; text-align: center; cursor: pointer;">
          <option value="">—</option>
          <option value="OPS" ${especValue === 'OPS' ? 'selected' : ''}>OPS</option>
          <option value="TKT" ${especValue === 'TKT' ? 'selected' : ''}>TKT</option>
          <option value="LL" ${especValue === 'LL' ? 'selected' : ''}>LL</option>
        </select>
      `;

      // Only show the checkbox for non-admin agents
      const checkboxHtml = a.type === 'admin' ? '<span style="color:#555;">—</span>' : `
        <input type="checkbox" onchange="toggleAgentExclusion(${a.id}, this.checked)" ${a.excluir ? 'checked' : ''} style="width: 15px; height: 16px; cursor: pointer; accent-color: var(--primary); vertical-align: middle;">
      `;

      return `
        <tr style="${rowStyle}" ${hoverAttrs}>
          <td style="padding: 10px 8px; color: #fff; font-weight: bold;">${escapeHtml(a.name)}</td>
          <td style="padding: 10px 8px; color: ${hasValidationError ? '#fca5a5' : '#a0a0a0'};">${escapeHtml(a.hours)}${warningBadge}</td>
          <td style="padding: 10px 8px;">${getRoleBadge(a.role)}</td>
          <td style="padding: 10px 8px; text-align: center;">${selectHtml}</td>
          <td style="padding: 10px 8px; text-align: center;">${checkboxHtml}</td>
          <td style="padding: 10px 8px; text-align: center;">
            <div style="display: flex; gap: 6px; justify-content: center; align-items: center;">
              <button onclick="startEditAgent(${a.id})" style="background: transparent; border: 1px solid #333; color: #888; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 11px;" title="Editar">✏️</button>
              <button onclick="deleteAgentFromPreview(${a.id})" style="background: transparent; border: 1px solid #333; color: var(--danger); padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 11px;" title="Eliminar">🗑️</button>
              <button onclick="insertAgentAfter(${a.id})" style="background: transparent; border: 1px solid #333; color: var(--success); padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; font-weight: bold;" title="Insertar agente debajo">+</button>
            </div>
          </td>
        </tr>`;
    }
  };

  // 1. TURNO MAÑANA · Roles Administrativos - Operativos
  html += `
    <tr style="background: #1a1a1a;">
      <td colspan="6" style="padding: 10px 8px; color: #888; font-weight: bold; font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid #333; font-family: inherit;">
        — TURNO MAÑANA · Roles Administrativos - Operativos
      </td>
    </tr>`;
  if (mañanaAdmins.length === 0) {
    html += `<tr><td colspan="6" style="padding: 8px 12px; color: #555; font-style: italic; font-size: 11.5px;">Ningún rol administrativo detectado</td></tr>`;
  } else {
    mañanaAdmins.forEach(a => { html += renderAgentRow(a); });
  }

  // 2. TURNO MAÑANA · Agentes de Pasaje
  html += `
    <tr style="background: #1a1a1a;">
      <td colspan="6" style="padding: 18px 8px 10px 8px; color: #888; font-weight: bold; font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid #333; font-family: inherit;">
        — TURNO MAÑANA · Agentes de Pasaje
      </td>
    </tr>`;
  if (mañanaPasajes.length === 0) {
    html += `<tr><td colspan="6" style="padding: 8px 12px; color: #555; font-style: italic; font-size: 11.5px;">Ningún agente de pasaje detectado</td></tr>`;
  } else {
    mañanaPasajes.forEach(a => { html += renderAgentRow(a); });
  }

  // 3. TURNO TARDE · Roles Administrativos - Operativos
  html += `
    <tr style="background: #1a1a1a;">
      <td colspan="6" style="padding: 18px 8px 10px 8px; color: #888; font-weight: bold; font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid #333; font-family: inherit;">
        — TURNO TARDE · Roles Administrativos - Operativos
      </td>
    </tr>`;
  if (tardeAdmins.length === 0) {
    html += `<tr><td colspan="6" style="padding: 8px 12px; color: #555; font-style: italic; font-size: 11.5px;">Ningún rol administrativo detectado</td></tr>`;
  } else {
    tardeAdmins.forEach(a => { html += renderAgentRow(a); });
  }

  // 4. TURNO TARDE · Agentes de Pasaje
  html += `
    <tr style="background: #1a1a1a;">
      <td colspan="6" style="padding: 18px 8px 10px 8px; color: #888; font-weight: bold; font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid #333; font-family: inherit;">
        — TURNO TARDE · Agentes de Pasaje
      </td>
    </tr>`;
  if (tardePasajes.length === 0) {
    html += `<tr><td colspan="6" style="padding: 8px 12px; color: #555; font-style: italic; font-size: 11.5px;">Ningún agente de pasaje detectado</td></tr>`;
  } else {
    tardePasajes.forEach(a => { html += renderAgentRow(a); });
  }

  container.innerHTML = html;
}

function startEditAgent(id) {
  editingAgentId = id;
  renderDetectedAgents();
}

function cancelEditAgent() {
  if (editingAgentId === newlyCreatedAgentId) {
    // Si cancelamos la edición de una fila recién creada con '+', la descartamos por completo
    extractedData.agents = extractedData.agents.filter(a => a.id !== newlyCreatedAgentId);
  }
  editingAgentId = null;
  newlyCreatedAgentId = null;
  renderDetectedAgents();
}

function saveEditAgent(id) {
  if (id === newlyCreatedAgentId) {
    newlyCreatedAgentId = null; // Si se guarda con éxito, reseteamos la variable de creación
  }
  const nameInput = document.getElementById(`edit_agent_name_${id}`);
  const hoursInput = document.getElementById(`edit_agent_hours_${id}`);
  const roleInput = document.getElementById(`edit_agent_role_${id}`);
  
  if (!nameInput || !hoursInput || !roleInput) return;

  const name = nameInput.value.trim();
  const hours = hoursInput.value.trim();
  const role = roleInput.value.trim().toUpperCase();

  if (!name || !hours || !role) {
    alert('El nombre, horario y rol son campos obligatorios.');
    return;
  }

  const agentIndex = extractedData.agents.findIndex(a => a.id === id);
  if (agentIndex !== -1) {
    const agent = extractedData.agents[agentIndex];
    agent.name = name;
    agent.hours = hours;
    agent.role = role;
    agent.rol = role;
    agent.validation_errors = validateAgentForImport(agent);
    if (agent.validation_errors.length > 0) {
      alert(
        'La fila se ha guardado, pero todavía necesita revisión:\n\n' +
        agent.validation_errors.join('\n')
      );
    }
  }

  editingAgentId = null;
  renderDetectedAgents();
}

function deleteAgentFromPreview(id) {
  if (confirm('¿Deseas eliminar a este agente de la previsualización?')) {
    extractedData.agents = extractedData.agents.filter(a => a.id !== id);
    renderDetectedAgents();
  }
}

function validateFlightForImport(flight) {
  const errors = [];
  const destination = String(flight.destination || '').trim();
  const number = String(flight.number || '').trim();
  const time = String(flight.time || '').trim();
  const pax = flight.pax;

  if (!destination) errors.push('Destino no detectado.');
  if (!number) errors.push('Número de vuelo no detectado.');
  if (!/^\d{2}:\d{2}$/.test(time)) {
    errors.push('STD no detectado o con formato inválido.');
  } else {
    const [hour, minute] = time.split(':').map(Number);
    if (hour > 23 || minute > 59) errors.push('STD fuera de rango.');
  }
  if (pax === null || pax === undefined || pax === '' || !Number.isInteger(Number(pax))) {
    errors.push('PAX/WEBS no detectado.');
  }
  return errors;
}

// Render flights table inside the preview page (Airport Terminal High-Fidelity Style)
function renderDetectedFlights() {
  const container = document.getElementById('detectedFlightsBody');
  if (!container) return;

  // Inicializa y migra las fechas independientes si fuera necesario.
  ensureExtractedDataShape();

  const titleElem = document.getElementById('detectedFlightsTitle');
  if (titleElem) {
    const flightsDate = extractedData?.flightsDate || '';
    titleElem.innerHTML = flightsDate
      ? `✈️ Parrilla de Vuelos — ${escapeHtml(flightsDate)}`
      : '✈️ Parrilla de Vuelos';
  }

  const calculateTimes = (stdStr) => {
    try {
      const normalizedStd = String(stdStr || '').trim();
      if (!/^\d{2}:\d{2}$/.test(normalizedStd)) {
        return { apertu: '?', emb: '?', std: '?' };
      }
      const [sh, sm] = normalizedStd.split(':').map(Number);
      if (sh > 23 || sm > 59) {
        return { apertu: '?', emb: '?', std: '?' };
      }
      let stdMins = sh * 60 + sm;
      
      // Boarding time (EMB) is 40 minutes before STD
      let embMins = stdMins - 40;
      if (embMins < 0) embMins += 1440;
      
      // Aperture time (APERTU) is 3 hours (180 minutes) before STD
      let apertuMins = stdMins - 180;
      if (apertuMins < 0) apertuMins += 1440;
      
      const formatMins = (m) => {
        const h = Math.floor(m / 60);
        const mins = m % 60;
        return `${String(h).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
      };
      
      return {
        apertu: formatMins(apertuMins),
        emb: formatMins(embMins),
        std: normalizedStd
      };
    } catch(e) {
      return { apertu: '?', emb: '?', std: '?' };
    }
  };

  container.innerHTML = extractedData.flights.map((f, idx) => {
    const isEditing = editingFlightId === f.id;
    const times = calculateTimes(f.time);
    const validationErrors = validateFlightForImport(f);
    f.validation_errors = validationErrors;
    const hasValidationError = validationErrors.length > 0;
    const missingValue = '<span style="color:#ef4444; font-weight:900;" title="Dato no detectado">?</span>';

    if (isEditing) {
      return `
        <tr style="border-bottom: 1px solid #282828; background: #1a1a1a;">
          <td style="padding: 8px 4px; color:#888;">${idx + 1}</td>
          <td style="padding: 8px 4px;"><input type="text" value="${escapeHtml(f.destination || '')}" id="edit_flight_dest_${f.id}" style="width: 100%; padding: 4px 6px; border: 1px solid var(--primary); border-radius: 4px; background: #000; color: #fff; font-family: inherit; font-size:12px; text-transform: uppercase;"></td>
          <td style="padding: 8px 4px;"><input type="text" value="${escapeHtml(f.number || '')}" id="edit_flight_number_${f.id}" style="width: 100%; padding: 4px 6px; border: 1px solid var(--primary); border-radius: 4px; background: #000; color: #fff; font-family: inherit; font-size:12px; text-transform: uppercase;"></td>
          <td style="padding: 8px 4px; color: var(--text-muted); font-size: 11px;">${times.apertu}</td>
          <td style="padding: 8px 4px;"><input type="text" value="${escapeHtml(f.agents || '')}" id="edit_flight_agents_${f.id}" style="width: 100%; padding: 4px 6px; border: 1px solid var(--primary); border-radius: 4px; background: #000; color: #fff; font-family: inherit; font-size:12px; text-transform: uppercase;"></td>
          <td style="padding: 8px 4px; color: var(--text-muted); font-size: 11px;">${times.emb}</td>
          <td style="padding: 8px 4px;"><input type="time" value="${f.time || ''}" id="edit_flight_time_${f.id}" style="width: 100%; padding: 4px 6px; border: 1px solid var(--primary); border-radius: 4px; background: #000; color: #fff; font-family: inherit; font-size:12px;"></td>
          <td style="padding: 8px 4px;"><input type="number" value="${f.pax !== undefined && f.pax !== null && f.pax !== '' ? f.pax : ''}" id="edit_flight_pax_${f.id}" min="10" max="300" style="width: 100%; padding: 4px 6px; border: 1px solid var(--primary); border-radius: 4px; background: #000; color: #fff; font-family: inherit; font-size:12px;" placeholder="—"></td>
          <td style="padding: 8px 4px; text-align: center;">
            <div style="display: flex; gap: 4px; justify-content: center;">
              <button onclick="saveEditFlight(${f.id})" style="background: var(--success); color: white; border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; font-weight:700;">✓</button>
              <button onclick="cancelEditFlight()" style="background: var(--text-muted); color: white; border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; font-weight:700;">✗</button>
            </div>
          </td>
        </tr>`;
    } else {
      const hasPax = f.pax !== undefined && f.pax !== null && f.pax !== '';
      const paxInt = hasPax ? parseInt(f.pax, 10) : NaN;
      const isLowPax = hasPax && !isNaN(paxInt) && paxInt <= 100;
      const paxColor = isLowPax ? '#22c55e' : '#a0a0a0';
      const paxWeight = isLowPax ? 'bold' : 'normal';
      const paxDisplay = hasPax ? f.pax : missingValue;
      const destinationDisplay = f.destination ? escapeHtml(f.destination) : missingValue;
      const numberDisplay = f.number ? getFlightNumberBadge(f.number) : missingValue;
      const timeIsMissing = times.std === '?';
      const rowStyle = hasValidationError
        ? 'border-bottom:1px solid #7f1d1d; background:rgba(239,68,68,0.10);'
        : 'border-bottom:1px solid #1f1f1f; transition:background 0.15s;';
      const hoverAttrs = hasValidationError
        ? ''
        : `onmouseover="this.style.background='#161616'" onmouseout="this.style.background='none'"`;
      
      return `
        <tr style="${rowStyle}" ${hoverAttrs}>
          <td style="padding: 10px 4px; color: #555; font-weight: bold;">${idx + 1}</td>
          <td style="padding: 10px 4px; color: #fff; font-weight: bold;">${destinationDisplay}</td>
          <td style="padding: 10px 4px;">${numberDisplay}</td>
          <td style="padding: 10px 4px; color: ${timeIsMissing ? '#ef4444' : '#a0a0a0'};">${times.apertu}</td>
          <td style="padding: 10px 4px; color: #777; font-style: italic;">${escapeHtml(f.agents || '')}</td>
          <td style="padding: 10px 4px; color: ${timeIsMissing ? '#ef4444' : '#a0a0a0'};">${times.emb}</td>
          <td style="padding: 10px 4px; color: ${timeIsMissing ? '#ef4444' : '#ff9f00'}; font-weight: bold;">${times.std}</td>
          <td style="padding: 10px 4px; color: ${hasPax ? paxColor : '#ef4444'}; font-weight: ${hasPax ? paxWeight : 'bold'};">${paxDisplay}</td>
          <td style="padding: 10px 4px; text-align: center;">
            <div style="display: flex; gap: 4px; justify-content: center; align-items: center;">
              <button onclick="startEditFlight(${f.id})" style="background: transparent; border: 1px solid #333; color: #888; padding: 4px 6px; border-radius: 4px; cursor: pointer; font-size: 11px;" title="Editar">✏️</button>
              <button onclick="deleteFlightFromPreview(${f.id})" style="background: transparent; border: 1px solid #333; color: var(--danger); padding: 4px 6px; border-radius: 4px; cursor: pointer; font-size: 11px;" title="Eliminar">🗑️</button>
              <button onclick="insertFlightAfter(${f.id})" style="background: transparent; border: 1px solid #333; color: var(--success); padding: 4px 6px; border-radius: 4px; cursor: pointer; font-size: 11px; font-weight: bold;" title="Insertar vuelo debajo">+</button>
            </div>
          </td>
        </tr>`;
    }
  }).join('');
}

// Inline edit handlers for flights
function startEditFlight(id) {
  editingFlightId = id;
  renderDetectedFlights();
}

function cancelEditFlight() {
  if (editingFlightId === newlyCreatedFlightId) {
    // Descartamos la fila de vuelo recién creada con '+' si se pulsa cancelar
    extractedData.flights = extractedData.flights.filter(f => f.id !== newlyCreatedFlightId);
  }
  editingFlightId = null;
  newlyCreatedFlightId = null;
  renderDetectedFlights();
}

function saveEditFlight(id) {
  if (id === newlyCreatedFlightId) {
    newlyCreatedFlightId = null; // Guardado con éxito, reseteamos la variable
  }
  const numberInput = document.getElementById(`edit_flight_number_${id}`);
  const destInput = document.getElementById(`edit_flight_dest_${id}`);
  const timeInput = document.getElementById(`edit_flight_time_${id}`);
  const agentsInput = document.getElementById(`edit_flight_agents_${id}`);
  const paxInput = document.getElementById(`edit_flight_pax_${id}`);

  if (!numberInput || !timeInput || !destInput) return;

  const number = numberInput.value.trim().toUpperCase();
  const destination = destInput.value.trim().toUpperCase();
  const time = timeInput.value.trim();
  const agents = agentsInput ? agentsInput.value.trim().toUpperCase() : '';
  
  let pax = null;
  if (paxInput && paxInput.value.trim() !== '') {
    pax = parseInt(paxInput.value, 10);
    if (isNaN(pax)) pax = null;
  }

  if (!number || !time || !destination) {
    alert('El número de vuelo, destino y la hora son obligatorios.');
    return;
  }

  const flightIndex = extractedData.flights.findIndex(f => f.id === id);
  if (flightIndex !== -1) {
    const flight = extractedData.flights[flightIndex];
    flight.number = number;
    flight.airline = number.substring(0, 2);
    flight.destination = destination;
    flight.time = time;
    flight.agents = agents;
    flight.pax = pax;
    flight.validation_errors = validateFlightForImport(flight);
    if (flight.validation_errors.length > 0) {
      alert(
        'La fila se ha guardado, pero todavía necesita revisión:\n\n' +
        flight.validation_errors.join('\n')
      );
    }
  }

  editingFlightId = null;
  renderDetectedFlights();
}

function deleteFlightFromPreview(id) {
  if (confirm('¿Deseas eliminar este vuelo de la previsualización?')) {
    extractedData.flights = extractedData.flights.filter(f => f.id !== id);
    renderDetectedFlights();
  }
}

function getTodayDisplayDate() {
  const today = new Date();
  const options = { weekday: 'long', day: 'numeric', month: 'long' };
  const dateStr = today.toLocaleDateString('es-ES', options);
  return dateStr.charAt(0).toUpperCase() + dateStr.slice(1);
}

// Estructura vacía con fechas independientes para cada cuadrante.
function initializeMockExtractedData() {
  extractedData = {
    agentsDate: '',
    flightsDate: '',
    agents: [],
    flights: []
  };
}

function ensureExtractedDataShape() {
  if (!extractedData) {
    initializeMockExtractedData();
    return;
  }
  // Migración defensiva desde la antigua propiedad compartida "date".
  if (typeof extractedData.agentsDate !== 'string') {
    extractedData.agentsDate = extractedData.agents?.length
      ? String(extractedData.date || '')
      : '';
  }
  if (typeof extractedData.flightsDate !== 'string') {
    extractedData.flightsDate = extractedData.flights?.length
      ? String(extractedData.date || '')
      : '';
  }
}
function zoomPreviewImage(url) {
  let lightbox = document.getElementById('lightboxModal');
  if (!lightbox) {
    lightbox = document.createElement('div');
    lightbox.id = 'lightboxModal';
    lightbox.className = 'modal-overlay';
    lightbox.style.zIndex = '2000';
    lightbox.onclick = () => lightbox.classList.remove('active');
    lightbox.innerHTML = `
      <div style="max-width: 95%; max-height: 95%; position: relative; display: flex; flex-direction: column; align-items: center; gap: 15px;" onclick="event.stopPropagation()">
        <!-- Image container scrollable with auto overflow to prevent cut-offs -->
        <div id="lightboxWrapper" style="overflow: auto; max-height: 80vh; max-width: 90vw; background: #000; border-radius: 8px; border: 1px solid var(--border); display: flex; align-items: flex-start; justify-content: center; padding: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.5);">
          <img id="lightboxImg" src="" style="width: 100%; max-width: none; transition: width 0.15s ease; cursor: grab;">
        </div>
        
        <!-- Zoom Controls -->
        <div style="display: flex; gap: 10px; background: rgba(0,0,0,0.85); padding: 8px 16px; border-radius: 30px; border: 1px solid var(--border); box-shadow: 0 4px 10px rgba(0,0,0,0.3); z-index: 2010;">
          <button onclick="changeLightboxZoom(0.2)" style="background: var(--bg-hover); color: white; border: none; width: 32px; height: 32px; border-radius: 50%; cursor: pointer; font-weight: bold; font-size:16px; display:flex; align-items:center; justify-content:center;" title="Acercar">+</button>
          <button onclick="changeLightboxZoom(-0.2)" style="background: var(--bg-hover); color: white; border: none; width: 32px; height: 32px; border-radius: 50%; cursor: pointer; font-weight: bold; font-size:16px; display:flex; align-items:center; justify-content:center;" title="Alejar">-</button>
          <button onclick="resetLightboxZoom()" style="background: var(--bg-hover); color: white; border: none; padding: 0 12px; height: 32px; border-radius: 16px; cursor: pointer; font-size:12px; font-weight: 600;" title="Restaurar">100%</button>
          <button onclick="document.getElementById('lightboxModal').classList.remove('active')" style="background: var(--danger); color: white; border: none; padding: 0 12px; height: 32px; border-radius: 16px; cursor: pointer; font-size:12px; font-weight: 600;" title="Cerrar">Cerrar</button>
        </div>
      </div>`;
    document.body.appendChild(lightbox);
  }
  
  document.getElementById('lightboxImg').src = url;
  currentZoomScale = 1.0; // Reset scale
  document.getElementById('lightboxImg').style.width = '100%';
  lightbox.classList.add('active');
}

let currentZoomScale = 1.0;

function changeLightboxZoom(diff) {
  const img = document.getElementById('lightboxImg');
  if (!img) return;
  currentZoomScale += diff;
  currentZoomScale = Math.max(0.6, Math.min(3.0, currentZoomScale)); // bound zoom scale between 60% and 300%
  img.style.width = (100 * currentZoomScale) + '%';
  
  // Update cursor based on zoom
  if (currentZoomScale > 1.0) {
    img.style.cursor = 'move';
  } else {
    img.style.cursor = 'grab';
  }
}

function resetLightboxZoom() {
  const img = document.getElementById('lightboxImg');
  if (!img) return;
  currentZoomScale = 1.0;
  img.style.width = '100%';
  img.style.cursor = 'grab';
}

function saveApiKey(val) {
  localStorage.setItem('aeroshift_openai_key', val.trim());
}

function saveBackendUrl(val) {
  localStorage.setItem('aeroshift_backend_url', val.trim());
}

// Listen to backendUrl changes
if (document.getElementById('backendUrl')) {
  document.getElementById('backendUrl').addEventListener('change', (e) => {
    saveBackendUrl(e.target.value);
  });
}

function resetGridAssignments() {
  if (confirm('¿Estás seguro de que deseas vaciar todas las asignaciones para la fecha seleccionada?')) {
    const date = document.getElementById('currentDate').value;
    state.assignments[date] = {};
    saveData();
    renderAll();
    
    const optStatus = document.getElementById('optStatus');
    if (optStatus) {
      optStatus.style.display = 'block';
      optStatus.className = 'opt-status-box info';
      optStatus.innerHTML = '<strong>Información:</strong> Se han vaciado todas las asignaciones del día.';
    }
  }
}

// ==========================================
// OR-TOOLS OPTIMIZER INTEGRATION
// ==========================================
async function runOrToolsOptimization() {
  const date = document.getElementById('currentDate').value;
  const optStatus = document.getElementById('optStatus');
  const minSep = parseInt(document.getElementById('optMinSep').value) || 45;
  const preferAirlines = document.getElementById('optPreferAirlines').checked;
  const backendUrl = document.getElementById('backendUrl').value.trim() || 'http://localhost:8000';
  const optModoElem = document.getElementById('optModo');
  const optModo = optModoElem ? optModoElem.value : 'PROPORCIONAL';

  if (!optStatus) return;

  optStatus.style.display = 'block';
  optStatus.className = 'opt-status-box info';
  optStatus.innerHTML = '<div style="display:flex; align-items:center; gap:10px;"><div class="spinner"></div><span>Conectando con el Servidor Backend OR-Tools...</span></div>';

  const payload = {
    agents: state.agents,
    flights: state.flights,
    min_separation: minSep,
    prefer_airlines: preferAirlines,
    modo: optModo
  };

  try {
    const response = await fetch(`${backendUrl}/optimize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Error de red: ${response.status}`);
    }

    const data = await response.json();
    if (data.success) {
      // Apply assignments
      state.assignments[date] = {};
      for (const [fId, aId] of Object.entries(data.assignments)) {
        state.assignments[date][parseInt(fId)] = aId;
      }
      saveData();
      renderAll();

      optStatus.className = 'opt-status-box success';
      optStatus.innerHTML = `
        <strong>¡Éxito matemático! (OR-Tools)</strong><br>
        La parrilla ha sido optimizada con éxito respetando todas las restricciones laborales.<br>
        - Asignaciones realizadas: ${Object.keys(data.assignments).length}<br>
        - Vuelos sin asignar por conflicto: ${data.unassigned_flights.length}<br>
        - Carga de trabajo máxima: ${data.max_workload} vuelos por agente.
      `;
    } else {
      throw new Error(data.message || 'El solucionador reportó un problema de factibilidad.');
    }
  } catch (error) {
    console.warn('Backend OR-Tools no disponible, ejecutando motor heurístico local:', error);
    
    // FALLBACK TO CLIENT-SIDE HEURISTIC OPTIMIZATION
    optStatus.className = 'opt-status-box info';
    optStatus.innerHTML = '<div style="display:flex; align-items:center; gap:10px;"><div class="spinner"></div><span>Servidor local no detectado. Optimizando localmente con Motor Heurístico AeroShift...</span></div>';
    
    setTimeout(() => {
      try {
        const localResults = clientSideOptimize(state.agents, state.flights, minSep, preferAirlines);
        state.assignments[date] = localResults.assignments;
        saveData();
        renderAll();

        optStatus.className = 'opt-status-box success';
        optStatus.style.borderLeft = '4px solid #f59e0b'; // Amber warning color to show it was local
        optStatus.innerHTML = `
          <strong>¡Parrilla Optimizada! (Motor Heurístico Local)</strong><br>
          <small style="color:var(--text-muted);">Nota: Servidor OR-Tools offline. Se utilizó el algoritmo local en JS.</small><br>
          - Asignaciones exitosas: ${localResults.assigned_count}<br>
          - Vuelos sin asignar por conflicto: ${localResults.unassigned_count}<br>
          - Carga máxima: ${localResults.max_workload} embarques/agente.
        `;
      } catch (err) {
        optStatus.className = 'opt-status-box error';
        optStatus.innerHTML = `<strong>Error de optimización:</strong> ${err.message}`;
      }
    }, 1000);
  }
}

// Local Heuristic Solver in JS
function getAgentExclusionIntervals(agent) {
  const intervals = [];
  const timeToMins = (t) => {
    if (!t || !t.includes(':')) return 0;
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };
  
  // 1. Split shift pause
  if (agent.bloque2 && agent.fin) {
    const b1_fin = timeToMins(agent.fin);
    const b2_ini = timeToMins(agent.bloque2.inicio);
    intervals.push({ ini: b1_fin, fin: b2_ini });
  }
  
  // 2. Mixed role interval
  const roleStr = agent.role || agent.rol || '';
  const match = roleStr.match(/\((\d{2}:\d{2})-(\d{2}:\d{2})\s+([A-ZÁÉÍÓÚÜÑ]+(?:\s+[A-ZÁÉÍÓÚÜÑ]+)*)\)/);
  if (match) {
    const [_, iniStr, finStr, restrictedRole] = match;
    const ROLES_NO_EMBARCAN = ['DSM','PSM','OPS','TKT','TKD','LL','SOMBRA','SHADOW','SHADOWING','FAMI','SICK','CURSO','NUEVO','NEW','AUTOCHECKIN'];
    const primaryReason = restrictedRole.toUpperCase().trim().split(/\s+/)[0];
    if (ROLES_NO_EMBARCAN.includes(primaryReason)) {
      intervals.push({
        ini: timeToMins(iniStr),
        fin: timeToMins(finStr)
      });
    }
  }
  
  return intervals;
}

function clientSideOptimize(agents, flights, minSep, preferAirlines) {
  const sortedFlights = [...flights].sort((a, b) => a.time.localeCompare(b.time));
  const assignments = {};
  const agentWorkloads = {};
  agents.forEach(a => { agentWorkloads[a.id] = 0; });

  const timeToMinutes = (tStr) => {
    const [h, m] = tStr.split(':').map(Number);
    return h * 60 + m;
  };

  const getFlightShift = (timeStr) => {
    const mins = timeToMinutes(timeStr);
    if (mins >= 360 && mins < 840) return 'morning';
    if (mins >= 840 && mins < 1320) return 'afternoon';
    return 'night';
  };

  let assignedCount = 0;
  let unassignedCount = 0;

  sortedFlights.forEach(f => {
    const fShift = getFlightShift(f.time);
    const fMins = timeToMinutes(f.time);

    // Find candidate agents
    const candidates = agents.filter(agent => {
      // 0. Roles y estados que nunca pueden embarcar durante toda la jornada.
      const roleText = String(agent.role || agent.rol || '').toUpperCase().trim();
      const baseRoleMatch = roleText.match(/^([A-ZÁÉÍÓÚÜÑ]+)/);
      const baseRole = baseRoleMatch ? baseRoleMatch[1] : '';
      const fullShiftStatus = !/\d{1,2}:\d{2}/.test(roleText)
        && /\((SICK|NUEVO|NEW)\)/.test(roleText);
      const fullShiftNoBoardRoles = ['DSM','PSM','OPS','TKT','TKD','LL','SOMBRA','SHADOW','SHADOWING','FAMI','SICK','CURSO','NUEVO','NEW','AUTOCHECKIN'];
      if (fullShiftNoBoardRoles.includes(baseRole) || fullShiftStatus) return false;

      // 1. Shift check
      if (!agent.shifts.includes(fShift)) return false;

      // 1b. Check overlap with exclusion intervals (mixed role / split shift pause)
      const exclIntervals = getAgentExclusionIntervals(agent);
      const flightStart = fMins - 40; // emb_inicio is STD - 40 mins
      const flightEnd = fMins + 15;   // emb_fin is STD + 15 mins
      
      let isExcluded = false;
      for (const interval of exclIntervals) {
        if (flightStart < interval.fin && flightEnd > interval.ini) {
          isExcluded = true;
          break;
        }
      }
      if (isExcluded) return false;

      // 2. Overlap check
      let overlap = false;
      const assignedToAgent = Object.entries(assignments)
        .filter(([_, aId]) => aId === agent.id)
        .map(([flId]) => flights.find(fl => fl.id === parseInt(flId)))
        .filter(Boolean);

      for (const af of assignedToAgent) {
        const afMins = timeToMinutes(af.time);
        let diff = Math.abs(fMins - afMins);
        if (diff > 1440 - minSep) diff = 1440 - diff; // midnight wrap
        if (diff < minSep) {
          overlap = true;
          break;
        }
      }

      return !overlap;
    });

    if (candidates.length === 0) {
      unassignedCount++;
      return;
    }

    // Score candidates
    const scoredCandidates = candidates.map(agent => {
      let score = 100;
      
      // Preferred airline match
      if (preferAirlines && agent.airline && agent.airline.toUpperCase() === f.airline.toUpperCase()) {
        score += 150;
      }
      
      // Workload penalty (lower workload = higher preference)
      const workload = agentWorkloads[agent.id] || 0;
      score -= workload * 30;

      return { agent, score };
    });

    // Sort by score descending
    scoredCandidates.sort((a, b) => b.score - a.score);
    const best = scoredCandidates[0].agent;

    assignments[f.id] = best.id;
    agentWorkloads[best.id] = (agentWorkloads[best.id] || 0) + 1;
    assignedCount++;
  });

  const workloadsList = Object.values(agentWorkloads);
  const maxWorkload = workloadsList.length > 0 ? Math.max(...workloadsList) : 0;

  return {
    assignments,
    assigned_count: assignedCount,
    unassigned_count: unassignedCount,
    max_workload: maxWorkload
  };
}

// ==========================================
// AI AUDITOR INTEGRATION
// ==========================================
async function runAiAudit() {
  const date = document.getElementById('currentDate').value;
  const container = document.getElementById('auditResultContainer');
  const openaiKey = localStorage.getItem('aeroshift_openai_key') || '';
  const backendUrl = document.getElementById('backendUrl').value.trim() || 'http://localhost:8000';
  const minSep = parseInt(document.getElementById('optMinSep').value) || 45;

  if (!container) return;

  container.innerHTML = `
    <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:200px; gap:12px; color:var(--text-muted);">
      <div class="spinner"></div>
      <strong>La Inteligencia Artificial está analizando tu parrilla de turnos...</strong>
      <small>Verificando tiempos de traslado, jornadas y equidad.</small>
    </div>
  `;

  const payload = {
    agents: state.agents,
    flights: state.flights,
    assignments: state.assignments[date] || {},
    min_separation: minSep
  };

  try {
    // Attempt backend first
    const response = await fetch(`${backendUrl}/audit`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiKey}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Servidor responde con error ${response.status}`);
    }

    const data = await response.json();
    renderAuditReport(data.report, data.score, data.rating, data.is_generative);

  } catch (error) {
    console.warn('Backend Auditor offline, ejecutando Auditoría IA Cliente (Local)...', error);
    
    // CHECK IF CLIENT-SIDE OPENAI IS POSSIBLE DIRECTLY
    if (openaiKey && openaiKey.length > 20) {
      try {
        // Direct Client-side OpenAI GPT-4o-mini request!
        const mathAudit = clientSideAudit(state.agents, state.flights, state.assignments[date] || {}, minSep);
        const report = await callOpenaiDirectly(openaiKey, mathAudit, minSep);
        renderAuditReport(report, mathAudit.score, mathAudit.rating, true);
        return;
      } catch (directErr) {
        console.warn('Fallo en llamada directa de OpenAI, usando reporte local:', directErr);
      }
    }

    // fallback to local rule-based technical audit report
    const localAudit = clientSideAudit(state.agents, state.flights, state.assignments[date] || {}, minSep);
    renderAuditReport(localAudit.report, localAudit.score, localAudit.rating, false);
  }
}

function renderAuditReport(markdown, score, rating, isGenerative) {
  const container = document.getElementById('auditResultContainer');
  if (!container) return;

  const htmlReport = parseMarkdown(markdown);
  
  let scoreColor = '#10b981'; // green
  if (score < 50) scoreColor = '#ef4444'; // red
  else if (score < 80) scoreColor = '#f59e0b'; // orange

  container.innerHTML = `
    <div class="audit-report">
      <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:2px solid var(--border); padding-bottom:12px; margin-bottom:16px;">
        <div>
          <span style="font-size:12px; text-transform:uppercase; font-weight:700; color:var(--text-muted); letter-spacing:0.5px;">Resultado de Auditoría</span>
          <h2 style="margin:0; font-size:20px; font-weight:800; color:${scoreColor}">${score}% — ${rating}</h2>
        </div>
        <div style="text-align:right;">
          <span style="font-size:11px; background:${isGenerative ? 'rgba(99, 102, 241, 0.15)' : 'var(--bg-hover)'}; color:${isGenerative ? '#6366f1' : 'var(--text-secondary)'}; padding:4px 8px; border-radius:12px; font-weight:600; text-transform:uppercase;">
            ${isGenerative ? '✨ GPT-4o-mini' : '💻 Motor Heurístico'}
          </span>
        </div>
      </div>
      <div class="audit-report-body">
        ${htmlReport}
      </div>
    </div>
  `;
}

// Direct OpenAI API Client Call (for local offline-backend mode with API key)
async function callOpenaiDirectly(apiKey, mathAudit, minSep) {
  const prompt = `
  Actúa como un experto consultor de operaciones de handling terrestre para aeropuertos de primer nivel.
  He realizado un análisis matemático y operativo de la parrilla de turnos y asignaciones de hoy.
  Por favor, redacta un informe de consultoría gerencial ejecutivo en español basándote estrictamente en estos datos de hoy:
  
  MÉTRICAS DEL ANÁLISIS:
  - Puntuación general de eficiencia: ${mathAudit.score}/100 (${mathAudit.rating})
  - Solapamientos críticos detectados (separación < ${minSep} min): ${mathAudit.overlaps.length}
  - Detalles de solapamientos: ${JSON.stringify(mathAudit.overlaps)}
  - Infracciones de turno detectadas (agente asignado fuera de su horario contratado): ${mathAudit.shift_violations.length}
  - Detalles de incidencias: ${JSON.stringify(mathAudit.shift_violations)}
  - Vuelos sin asignar: ${mathAudit.unassigned_count} (Vuelos: ${JSON.stringify(mathAudit.unassigned_flights)})
  - Rango de desequilibrio de carga laboral: Max ${mathAudit.max_w} vs Min ${mathAudit.min_w} vuelos. ${mathAudit.imbalance_details}
  - Coincidencias exitosas de aerolínea preferida logradas: ${mathAudit.successful_preferences}
  
  Instrucciones de formato:
  1. Saluda como "AeroShift Copilot" (Asistente IA direct-to-cloud).
  2. Redacta el informe con estilo pulido, asertivo, estructurado en secciones ejecutivas con formato Markdown.
  3. Proporciona recomendaciones directas para resolver los solapamientos críticos (sugiere utilizar el Optimizador Matemático OR-Tools).
  4. Redacta de forma amigable y concisa (máximo 400 palabras).
  `;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Eres AeroShift Copilot, un auditor de operaciones terrestres aeroportuarias de handling.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.7
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI responde con error: ${response.status}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

// Client-side math auditor in JS
function clientSideAudit(agents, flights, assignments, minSep) {
  const overlaps = [];
  const shift_violations = [];
  const unassigned_flights = [];
  let successful_preferences = 0;

  const timeToMinutes = (tStr) => {
    const [h, m] = tStr.split(':').map(Number);
    return h * 60 + m;
  };

  const getFlightShift = (timeStr) => {
    const mins = timeToMinutes(timeStr);
    if (mins >= 360 && mins < 840) return 'morning';
    if (mins >= 840 && mins < 1320) return 'afternoon';
    return 'night';
  };

  const getShiftLabel = (key) => {
    const map = { morning: 'Mañana (06:00-14:00)', afternoon: 'Tarde (14:00-22:00)', night: 'Noche (22:00-06:00)' };
    return map[key] || key;
  };

  // Group flights assigned to each agent
  const agentFlights = {};
  agents.forEach(a => { agentFlights[a.id] = []; });

  flights.forEach(f => {
    const assignedAgentId = assignments[f.id];
    if (assignedAgentId) {
      if (agentFlights[assignedAgentId]) {
        agentFlights[assignedAgentId].push(f);
      }
    } else {
      unassigned_flights.push(f);
    }
  });

  // Check Overlaps & Shift Violations
  agents.forEach(agent => {
    const aFlights = agentFlights[agent.id] || [];
    const sorted = [...aFlights].sort((a, b) => a.time.localeCompare(b.time));

    // Overlaps
    for (let i = 0; i < sorted.length - 1; i++) {
      const f1 = sorted[i];
      const f2 = sorted[i+1];
      const t1 = timeToMinutes(f1.time);
      const t2 = timeToMinutes(f2.time);
      
      let diff = Math.abs(t1 - t2);
      if (diff > 1440 - minSep) diff = 1440 - diff;

      if (diff < minSep) {
        overlaps.push({
          agentName: agent.name,
          flight1: f1,
          flight2: f2,
          separation: diff
        });
      }
    }

    // Shifts
    sorted.forEach(f => {
      const fShift = getFlightShift(f.time);
      if (!agent.shifts.includes(fShift)) {
        shift_violations.push({
          agentName: agent.name,
          flightNumber: f.number,
          flightTime: f.time,
          flightShift: fShift,
          agentShifts: agent.shifts
        });
      }

      // Check mixed role exclusions or split shift pauses in audit
      const exclIntervals = getAgentExclusionIntervals(agent);
      const fMins = timeToMinutes(f.time);
      const flightStart = fMins - 40;
      const flightEnd = fMins + 15;
      
      let isExcluded = false;
      let violatedInterval = null;
      for (const interval of exclIntervals) {
        if (flightStart < interval.fin && flightEnd > interval.ini) {
          isExcluded = true;
          violatedInterval = interval;
          break;
        }
      }
      if (isExcluded) {
        const minsToHms = (m) => {
          const hrs = Math.floor(m / 60);
          const mns = m % 60;
          return `${String(hrs).padStart(2, '0')}:${String(mns).padStart(2, '0')}`;
        };
        shift_violations.push({
          agentName: agent.name,
          flightNumber: f.number,
          flightTime: f.time,
          flightShift: fShift,
          agentShifts: agent.shifts,
          isExclusionInterval: true,
          intervalStr: `${minsToHms(violatedInterval.ini)}-${minsToHms(violatedInterval.fin)}`
        });
      }

      // Preference
      if (agent.airline && agent.airline.toUpperCase() === f.airline.toUpperCase()) {
        successful_preferences++;
      }
    });
  });

  // Workloads
  const activeWorkloads = Object.values(agentFlights).map(list => list.length);
  const max_w = activeWorkloads.length > 0 ? Math.max(...activeWorkloads) : 0;
  const min_w = activeWorkloads.length > 0 ? Math.min(...activeWorkloads) : 0;
  const w_range = max_w - min_w;
  const imbalanced = w_range >= 3 && agents.length > 1;

  let score = 100;
  score -= overlaps.length * 25;
  score -= shift_violations.length * 15;
  score -= unassigned_flights.length * 5;
  if (imbalanced) score -= 8;
  score = Math.max(0, Math.min(100, score));

  let rating = "Sobresaliente 🌟";
  if (score < 50) rating = "Crítico / Deficiente 🚨";
  else if (score < 75) rating = "Aceptable con Errores ⚠️";
  else if (score < 90) rating = "Bueno / Mejorable 👍";

  // Build markdown text
  let md = `# Informe de Auditoría Operativa

## Eficiencia de la Parrilla: **${score}%** (${rating})

---

### 🚨 Conflictos de Horarios (Solapamientos): ${overlaps.length}
`;

  if (overlaps.length === 0) {
    md += '✅ **Excelente.** Ningún agente tiene solapamiento de tareas para hoy.\n';
  } else {
    overlaps.forEach(o => {
      md += `- **${o.agentName}** tiene vuelos excesivamente seguidos:\n`;
      md += `  - \`${o.flight1.number}\` (${o.flight1.time}) Puerta \`${o.flight1.gate}\`\n`;
      md += `  - \`${o.flight2.number}\` (${o.flight2.time}) Puerta \`${o.flight2.gate}\`\n`;
      md += `  - *Separación:* ${o.separation} min. (Min. requerido: ${minSep} min).\n`;
    });
  }

  md += `
### 🕒 Incidencias de Jornada Laboral: ${shift_violations.length}
`;

  if (shift_violations.length === 0) {
    md += '✅ **Cumplimiento total.** Todos los agentes asignados operan dentro de su jornada laboral contratada.\n';
  } else {
    shift_violations.forEach(sv => {
      if (sv.isExclusionInterval) {
        md += `- **${sv.agentName}** está asignado al vuelo \`${sv.flightNumber}\` (${sv.flightTime}), pero tiene una restricción horaria / de rol mixto o pausa durante el intervalo **${sv.intervalStr}**.\n`;
      } else {
        const shiftsStr = sv.agentShifts.map(sh => getShiftLabel(sh)).join(', ');
        md += `- **${sv.agentName}** está asignado al vuelo \`${sv.flightNumber}\` (${sv.flightTime}) en el turno de **${getShiftLabel(sv.flightShift)}**, pero su contrato es de **${shiftsStr}**.\n`;
      }
    });
  }

  md += `
### 📦 Vuelos Pendientes de Asignación: ${unassigned_flights.length}
`;

  if (unassigned_flights.length === 0) {
    md += '✅ **Cero desatenciones.** Todos los vuelos del aeropuerto tienen agentes asignados para coordinar el embarque.\n';
  } else {
    md += `⚠️ **Hay ${unassigned_flights.length} vuelo(s) sin atender:**\n`;
    unassigned_flights.forEach(f => {
      md += `- \`${f.number}\` (${f.time}) -> destino \`${f.destination}\` (Puerta \`${f.gate}\`).\n`;
    });
  }

  md += `
### ⚖️ Distribución Operativa de Cargas
`;

  if (imbalanced) {
    md += `⚠️ **Desequilibrio operativo severo:** Rango de diferencia es de ${w_range} vuelos. Unos agentes tienen ${max_w} vuelos mientras que otros tienen ${min_w} vuelos. Se aconseja redistribuir tareas.\n`;
  } else {
    md += `✅ **Carga bien distribuida.** La diferencia máxima de tareas entre agentes activos es de solo ${w_range} vuelo(s).\n`;
  }

  md += `
### ✈️ Afinidad por Aerolínea Contratada
- Coincidencias logradas: **${successful_preferences}** de tus asignaciones manuales.
`;

  return {
    score,
    rating,
    overlaps,
    shift_violations,
    unassigned_count: unassigned_flights.length,
    unassigned_flights: unassigned_flights.map(f => f.number),
    max_w,
    min_w,
    imbalance_details: imbalanced ? `Diferencia de ${w_range} vuelos` : 'Equilibrado',
    successful_preferences,
    report: md
  };
}

// ==========================================
// REGEX-BASED MARKDOWN PARSER (LINE-BY-LINE)
// ==========================================
function parseMarkdown(md) {
  const lines = md.split('\n');
  let inList = false;
  const htmlLines = [];

  lines.forEach(line => {
    const cleanLine = line.trim();
    if (cleanLine.startsWith('- ')) {
      if (!inList) {
        htmlLines.push('<ul>');
        inList = true;
      }
      const content = cleanLine.substring(2);
      htmlLines.push(`<li>${parseInlineMarkdown(content)}</li>`);
    } else {
      if (inList) {
        htmlLines.push('</ul>');
        inList = false;
      }
      
      if (cleanLine.startsWith('# ')) {
        htmlLines.push(`<h1>${parseInlineMarkdown(cleanLine.substring(2))}</h1>`);
      } else if (cleanLine.startsWith('## ')) {
        htmlLines.push(`<h2>${parseInlineMarkdown(cleanLine.substring(3))}</h2>`);
      } else if (cleanLine.startsWith('### ')) {
        htmlLines.push(`<h3>${parseInlineMarkdown(cleanLine.substring(4))}</h3>`);
      } else if (cleanLine === '---') {
        htmlLines.push('<hr>');
      } else if (cleanLine !== '') {
        htmlLines.push(`<p>${parseInlineMarkdown(cleanLine)}</p>`);
      }
    }
  });

  if (inList) {
    htmlLines.push('</ul>');
  }

  return htmlLines.join('\n');
}

function parseInlineMarkdown(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.*?)`/g, '<code>$1</code>');
}

async function downloadExtractionXlsx(type) {
  ensureExtractedDataShape();
  const isAgents = type === 'agents';
  const exportDate = isAgents
    ? extractedData.agentsDate
    : extractedData.flightsDate;
  const rows = isAgents ? extractedData?.agents : extractedData?.flights;
  if (!Array.isArray(rows) || rows.length === 0) {
    alert(isAgents ? 'No hay turnos para descargar.' : 'No hay vuelos para descargar.');
    return;
  }

  const backendInput = document.getElementById('backendUrl');
  const backendUrl = backendInput ? backendInput.value.trim() : 'https://aeroshift-backend.onrender.com';
  const payload = {
    type: type,
    date: exportDate || 'Fecha no detectada',
    agents: isAgents ? extractedData.agents : [],
    flights: isAgents ? [] : extractedData.flights
  };

  try {
    const response = await fetch(`${backendUrl}/export-extraction-xlsx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      let message = 'No se pudo generar el archivo Excel.';
      try {
        const errorData = await response.json();
        message = errorData.detail || message;
      } catch (_) {}
      throw new Error(message);
    }

    const blob = await response.blob();
    const disposition = response.headers.get('Content-Disposition') || '';
    const filenameMatch = disposition.match(/filename="?([^";]+)"?/i);
    const fallbackDate = String(exportDate || 'sin-fecha')
      .replace(/[^0-9A-Za-z_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'sin-fecha';
    const filename = filenameMatch
      ? filenameMatch[1]
      : `aeroshift_${isAgents ? 'turnos' : 'vuelos'}_${fallbackDate}.xlsx`;

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    alert(`Error al descargar el Excel:\n\n${error.message}`);
  }
}

function clearDetectedAgents() {
  if (confirm('¿Deseas vaciar por completo la lista de turnos de personal?')) {
    ensureExtractedDataShape();
    extractedData.agents = [];
    extractedData.agentsDate = '';

    // Filter out turnos files from the global file preview list!
    uploadedFilesCopy = uploadedFilesCopy.filter(f => f.type !== 'agents');
    renderDetectedAgents();
    renderUploadedFilesList();
  }
}

function clearDetectedFlights() {
  if (confirm('¿Deseas vaciar por completo la parrilla de vuelos?')) {
    ensureExtractedDataShape();
    extractedData.flights = [];
    extractedData.flightsDate = '';

    // Filter out flights files from the global file list!
    uploadedFilesCopy = uploadedFilesCopy.filter(f => f.type !== 'flights');
    renderDetectedFlights();
    renderUploadedFilesList();
  }
}

function getRoleBadge(roleStr) {
  if (!roleStr) return '';
  const role = roleStr.toUpperCase().trim();
  let color = '#ffffff'; // Default to white (which is also CSA)
  
  // Los departamentos tienen prioridad sobre CSA en roles completos o mixtos.
  if (role.includes('TKT')) { color = '#22c55e'; }       // Verde: Ventas / TKT
  else if (role.includes('LL')) { color = '#eab308'; }   // Amarillo: Llegadas / Equipajes
  else if (role.includes('OPS')) { color = '#22d3ee'; }  // Turquesa: Operaciones
  else if (role.includes('DSM')) { color = '#c084fc'; }  // Morado: DSM
  else if (role.includes('PSM')) { color = '#f472b6'; }  // Rosa: PSM
  else if (role.includes('CSA')) { color = '#ffffff'; }  // Blanco: CSA sin departamento
  
  return `<span style="color: ${color}; font-weight: bold; text-transform: uppercase; font-family: monospace; font-size: 12px; letter-spacing: 0.5px;">${roleStr}</span>`;
}

function getFlightNumberBadge(numberStr) {
  if (!numberStr) return '';
  const num = numberStr.toUpperCase().trim();
  if (num.startsWith('FR')) {
    return `<span style="color: #378add; font-weight: bold;">${escapeHtml(numberStr)}</span>`;
  } else {
    // Other airlines (like RR, RK, etc.) in a vibrant highlight color pill!
    return `<span style="background: rgba(244, 63, 94, 0.15); color: #f43f5e; padding: 3px 8px; border-radius: 4px; font-weight: bold; border: 1px solid rgba(244,63,94,0.3); letter-spacing: 0.5px; font-size: 11.5px; font-family: monospace;">${escapeHtml(numberStr)}</span>`;
  }
}



function updateAgentEspec(id, val) {
  const agent = extractedData.agents.find(a => a.id === id);
  if (agent) {
    agent.espec = val ? [val] : [];
    saveData();
  }
}

function toggleAgentExclusion(id, checked) {
  const agent = extractedData.agents.find(a => a.id === id);
  if (agent) {
    agent.excluir = checked ? true : false;
    saveData();
  }
}


function insertAgentAfter(id) {
  const currentAgent = extractedData.agents.find(a => a.id === id);
  const newId = Math.max(...extractedData.agents.map(a => a.id), 0) + 1;
  newlyCreatedAgentId = newId; // Guardamos el ID de la fila recién insertada
  
  const newAgent = {
    id: newId,
    name: 'NUEVO AGENTE',
    hours: currentAgent ? currentAgent.hours : '08:00-16:00',
    role: 'CSA',
    type: currentAgent ? currentAgent.type : 'pasaje',
    shift: currentAgent ? currentAgent.shift : 'mañana',
    espec: [],
    excluir: false
  };

  const idx = extractedData.agents.findIndex(a => a.id === id);
  if (idx !== -1) {
    extractedData.agents.splice(idx + 1, 0, newAgent);
    editingAgentId = newId; // Abre la edición en línea al instante para facilitar la escritura!
    renderDetectedAgents();
  }
}


function insertFlightAfter(id) {
  const currentFlight = extractedData.flights.find(f => f.id === id);
  const newId = Math.max(...extractedData.flights.map(f => f.id), 0) + 1;
  newlyCreatedFlightId = newId; // Guardamos el ID de la fila recién insertada
  
  const newFlight = {
    id: newId,
    destination: currentFlight ? currentFlight.destination : null,
    airline: currentFlight ? currentFlight.airline : null,
    number: currentFlight && currentFlight.number ? currentFlight.number + 'A' : null,
    time: currentFlight ? currentFlight.time : null,
    agents: '',
    pax: currentFlight ? currentFlight.pax : null,
    validation_errors: []
  };

  const idx = extractedData.flights.findIndex(f => f.id === id);
  if (idx !== -1) {
    extractedData.flights.splice(idx + 1, 0, newFlight);
    editingFlightId = newId; // Abre la edición en línea al instante para facilitar la escritura!
    renderDetectedFlights();
  }
}


function renderUploadedFilesList() {
  const filesListContainer = document.getElementById('uploadedFilesListPage');
  if (!filesListContainer) return;

  const getFilePresentation = (filename) => {
    const lowerName = String(filename || '').toLowerCase();
    if (/\.(png|jpe?g|webp|gif|bmp)$/.test(lowerName)) {
      return { kind: 'image', label: 'IMAGEN', description: 'Haz clic para ampliar', color: '#378add' };
    }
    if (/\.xlsx$/.test(lowerName)) {
      return { kind: 'xlsx', label: 'XLSX', description: 'Hoja de cálculo Excel', color: '#22c55e' };
    }
    if (/\.xls$/.test(lowerName)) {
      return { kind: 'xlsx', label: 'XLS', description: 'Hoja de cálculo Excel', color: '#22c55e' };
    }
    if (/\.csv$/.test(lowerName)) {
      return { kind: 'csv', label: 'CSV', description: 'Datos tabulares', color: '#14b8a6' };
    }
    if (/\.pdf$/.test(lowerName)) {
      return { kind: 'pdf', label: 'PDF', description: 'Documento PDF', color: '#ef4444' };
    }
    const extension = lowerName.includes('.') ? lowerName.split('.').pop().toUpperCase() : 'ARCHIVO';
    return { kind: 'file', label: extension, description: 'Archivo cargado', color: '#94a3b8' };
  };

  let listHtml = '';
  for (let i = 0; i < uploadedFilesCopy.length; i++) {
    const file = uploadedFilesCopy[i];
    const presentation = getFilePresentation(file.name);
    let previewHtml = '';

    if (presentation.kind === 'image') {
      previewHtml = `
        <div style="width:100%; height:80px; border-radius:4px; overflow:hidden; background:#000; border:1px solid var(--border); display:flex; align-items:center; justify-content:center; cursor:pointer;" onclick="zoomPreviewImage('${file.blobUrl}')" title="Haga clic para ampliar">
          <img src="${file.blobUrl}" alt="Vista previa del archivo" style="max-width:100%; max-height:100%; object-fit:contain;">
        </div>`;
    } else {
      previewHtml = `
        <div style="width:100%; height:80px; border-radius:4px; background:linear-gradient(135deg, rgba(255,255,255,0.025), rgba(255,255,255,0.06)); border:1px solid ${presentation.color}55; display:flex; align-items:center; justify-content:center; gap:12px; cursor:default;" title="${escapeHtml(presentation.description)}">
          <div style="width:42px; height:50px; border:1px solid ${presentation.color}; border-radius:5px; display:flex; align-items:center; justify-content:center; position:relative; background:${presentation.color}12; color:${presentation.color}; box-shadow:inset 0 0 12px ${presentation.color}0d;">
            <svg width="23" height="28" viewBox="0 0 24 28" fill="none" aria-hidden="true">
              <path d="M4 1.5h10l6 6V26.5H4z" stroke="currentColor" stroke-width="1.7"/>
              <path d="M14 1.5v6h6" stroke="currentColor" stroke-width="1.7"/>
            </svg>
          </div>
          <div style="display:flex; flex-direction:column; gap:3px; min-width:72px;">
            <strong style="font-size:14px; line-height:1; color:${presentation.color}; letter-spacing:0.8px;">${escapeHtml(presentation.label)}</strong>
            <span style="font-size:10px; color:#777; white-space:nowrap;">${escapeHtml(presentation.description)}</span>
          </div>
        </div>`;
    }

    listHtml += `
      <div style="display:flex; flex-direction:column; gap:8px; background:var(--bg-card); padding:0; border-radius:6px; border:1px solid var(--border); max-width:240px; width:100%; box-shadow:0 2px 4px rgba(0,0,0,0.15); flex-shrink:0; text-align:left;">
        <div style="display:flex; align-items:center; gap:6px; text-overflow:ellipsis; overflow:hidden; white-space:nowrap; padding:6px 8px 0 8px;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="3" style="stroke:var(--success); flex-shrink:0;"><polyline points="20 6 9 17 4 12"/></svg>
          <span style="font-weight:700; font-size:12px; text-overflow:ellipsis; overflow:hidden; white-space:nowrap; color:#fff;" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
        </div>
        ${previewHtml}
      </div>`;
  }
  filesListContainer.innerHTML = listHtml;
}
