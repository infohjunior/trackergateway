// ===== Configuração inicial do mapa =====
const map = L.map('map').setView([-15.7801, -47.9292], 4);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, // OSM não fornece tiles além de 19; valores maiores só deixam o tile borrado (upscale)
    attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

// Grupo de camadas para markers/labels — facilita limpar e replotar sem acumular lixo no mapa
const pointsLayer = L.layerGroup().addTo(map);
window.routeLine = null;

// Arquivo de log a ser lido (mesma pasta do index.html)
const LOG_URL = 'logs/log_gateway.txt';

// Velocidade (km/h) acima da qual o ponto é destacado em laranja
const SPEED_LIMIT = 110;

// Guarda os markers na mesma ordem dos pontos, para sincronizar com a lista lateral
let markers = [];
let selectedIndex = -1;

// ===== Carregamento e parsing do log =====
// Formato esperado por linha (tudo antes do tipo da mensagem é ignorado):
// [prefixo do gateway] TIPO;ID;HEX;NUM;FIRMWARE;X;YYYYMMDD;HH:MM:SS;LAT;LON;VEL;...
// Ex.: 23/09/2026 16:20:43 - [ASCII C000] STT;2180000019;FFF83F;218;1.1.26;1;20260923;19:20:19;-22.847620;-47.085808;0.00;...
// Latitude = campo 9 (índice 8) | Longitude = campo 10 (índice 9), em base 1.
// Velocidade (km/h) = índice 10 (campo 11, em base 1).
async function loadLog(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Falha ao carregar ${url}: ${response.status} ${response.statusText}`);
    }
    const data = await response.text();

    return data
        .split(/\r?\n/)               // trata quebras de linha \n e \r\n
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .map(line => parseLogLine(line))
        .filter(entry => entry !== null);
}

// Tipos de mensagem Suntech reconhecidos (início real da mensagem)
const MSG_TYPES = 'STT|ALT|RES|ACL|ALV|CMD|UEX|TRV|PRG|ASTT|AALT|ARTV|AUEX';

// Captura a mensagem a partir do primeiro tipo encontrado, ignorando
// tudo o que vier antes (data/hora do gateway, "[ASCII C000]", etc.)
const MSG_REGEX = new RegExp(`(?:${MSG_TYPES});.*$`);

function parseLogLine(line) {
    const match = line.match(MSG_REGEX);
    if (!match) return null; // linha sem mensagem Suntech: ignora

    const message = match[0];
    const fields = message.split(';');

    // Precisa ter ao menos até o campo de longitude (índice 9)
    if (fields.length < 10) return null;

    const lat = parseFloat(fields[8]);
    const lon = parseFloat(fields[9]);

    if (isNaN(lat) || isNaN(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

    const speedRaw = parseFloat(fields[10]);
    const speed = isNaN(speedRaw) ? null : speedRaw;

    return {
        raw: message,                      // só a mensagem, sem o prefixo
        type: fields[0] || '',
        id: fields[1] || '',
        dateRaw: fields[6] || '',
        timeRaw: fields[7] || '',
        lat,
        lon,
        speed,
        isSpeeding: speed !== null && speed > SPEED_LIMIT
    };
}

function formatSpeed(speed) {
    return speed === null ? '-' : `${speed.toFixed(1)} km/h`;
}

function formatDate(yyyymmdd) {
    if (!/^\d{8}$/.test(yyyymmdd)) return yyyymmdd || '-';
    return `${yyyymmdd.slice(6, 8)}/${yyyymmdd.slice(4, 6)}/${yyyymmdd.slice(0, 4)}`;
}

// ===== Ícone numerado (substitui o par marker + label separados) =====
// Quando o ponto está com velocidade acima de SPEED_LIMIT, o número fica
// laranja e um selo com a velocidade é exibido abaixo do marker.
function numberedIcon(number, point) {
    const isSpeeding = !!(point && point.isSpeeding);

    const speedBadge = isSpeeding
        ? `<div style="position:absolute; top:4px; left:50%; transform:translateX(-50%);
                       background:#ff8c00; color:#fff; padding:1px 6px; border-radius:4px;
                       font-size:11px; font-weight:bold; white-space:nowrap;
                       box-shadow:0 0 3px rgba(0,0,0,0.5);">${formatSpeed(point.speed)}</div>`
        : '';

    return L.divIcon({
        className: 'numbered-marker',
        html: `
            <div style="position:relative;">
                <b style="position:absolute; top:-18px; left:50%; transform:translateX(-50%);
                          color:${isSpeeding ? '#ff8c00' : 'yellow'}; text-shadow:1px 1px 2px #000; font-size:13px;">${number}</b>
                ${speedBadge}
            </div>
        `,
        iconSize: [0, 0], // não interfere na posição do marker "de verdade" logo abaixo
        iconAnchor: [0, 0]
    });
}

function distanceLabelIcon(text) {
    return L.divIcon({
        className: 'distance-label',
        html: `<div style="border-radius:5px;padding:2px 6px;font-size:12px;background:white;opacity:0.9;white-space:nowrap;">${text}</div>`,
        iconSize: [0, 0]
    });
}

function formatDistance(meters) {
    return meters >= 1000
        ? `${(meters / 1000).toFixed(2)} km`
        : `${meters.toFixed(1)} m`;
}

// ===== Seleção sincronizada entre mapa e painel lateral =====
function selectPoint(index, { fromList = false, panTo = true } = {}) {
    selectedIndex = index;

    document.querySelectorAll('#pointsList li').forEach(li => {
        li.classList.toggle('selected', Number(li.dataset.index) === index);
    });

    if (fromList) {
        const li = document.querySelector(`#pointsList li[data-index="${index}"]`);
        if (li) li.scrollIntoView({ block: 'nearest' });
    }

    const marker = markers[index];
    if (marker) {
        if (panTo) map.setView(marker.getLatLng(), Math.max(map.getZoom(), 15));
        marker.openPopup();
    }
}

// ===== Renderização do painel lateral com os dados do log =====
function renderPanel(points) {
    const list = document.getElementById('pointsList');
    const countEl = document.getElementById('pointsCount');
    list.innerHTML = '';

    const speedingCount = points.filter(p => p.isSpeeding).length;
    countEl.textContent = speedingCount > 0
        ? `${points.length} ponto(s) — ${speedingCount} acima de ${SPEED_LIMIT} km/h`
        : `${points.length} ponto(s)`;

    points.forEach((point, index) => {
        const number = index + 1;
        const li = document.createElement('li');
        li.dataset.index = String(index);

        li.classList.toggle('speeding', point.isSpeeding);

        li.innerHTML = `
            <div class="point-header">
                <span class="point-number">${number}</span>
                <span class="point-type">${point.type || '—'}</span>
                <span class="point-datetime">${formatDate(point.dateRaw)} ${point.timeRaw || ''}</span>
            </div>
            <div class="point-coords">${point.lat.toFixed(6)}, ${point.lon.toFixed(6)}</div>
            <div class="point-speed${point.isSpeeding ? ' speed-high' : ''}">
                Velocidade: ${formatSpeed(point.speed)}${point.isSpeeding ? ' ⚠' : ''}
            </div>
            <button type="button" class="toggle-raw-btn">ver linha do log</button>
            <pre class="point-raw" hidden>${point.raw}</pre>
        `;

        li.addEventListener('click', (ev) => {
            // Não seleciona o ponto se o clique foi no botão "ver linha do log"
            if (ev.target.closest('.toggle-raw-btn')) return;
            selectPoint(index, { fromList: true });
        });

        li.querySelector('.toggle-raw-btn').addEventListener('click', (ev) => {
            ev.stopPropagation();
            const pre = li.querySelector('.point-raw');
            pre.hidden = !pre.hidden;
        });

        list.appendChild(li);
    });
}

// ===== Copiar coordenadas para a área de transferência =====
function copyToClipboard(text) {
    navigator.clipboard.writeText(text)
        .then(() => alert('Coordenadas copiadas!'))
        .catch(() => alert('Erro ao copiar'));
}

// ===== Função principal =====
async function plotPoints() {
    let points;
    try {
        points = await loadLog(LOG_URL);
    } catch (err) {
        console.error(err);
        alert(`Não foi possível carregar ${LOG_URL}. Veja o console para detalhes.`);
        return;
    }

    // Limpa plotagem anterior (evita duplicar markers se plotPoints for chamada de novo)
    pointsLayer.clearLayers();
    markers = [];
    selectedIndex = -1;
    if (window.routeLine) {
        map.removeLayer(window.routeLine);
        window.routeLine = null;
    }

    if (points.length === 0) {
        alert(`Nenhuma linha com latitude/longitude válida foi encontrada em ${LOG_URL}.`);
        renderPanel([]);
        return;
    }

    // Deduplicação de coordenadas idênticas consecutivas (ex.: veículo parado
    // enviando a mesma posição várias vezes), preservando a ordem original
    const seen = new Set();
    const uniquePoints = points.filter(p => {
        const key = `${p.lat},${p.lon}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    const latLngs = uniquePoints.map(p => [p.lat, p.lon]);

    uniquePoints.forEach((point, index) => {
        const number = index + 1;

        // Marker principal com popup
        const marker = L.marker([point.lat, point.lon], { icon: numberedIcon(number, point) })
            .addTo(pointsLayer);

        marker.bindPopup(`
            <b>Ponto ${number}</b> — ${point.type || ''}<br>
            ${formatDate(point.dateRaw)} ${point.timeRaw || ''}<br>
            Lat: ${point.lat.toFixed(6)}<br>
            Lng: ${point.lon.toFixed(6)}<br>
            Velocidade: <span style="${point.isSpeeding ? 'color:#ff8c00;font-weight:bold;' : ''}">${formatSpeed(point.speed)}</span><br><br>
            <button type="button" class="copy-coords-btn">Copiar</button>
        `);

        // Usa o evento popupopen em vez de onclick inline (mais seguro e evita
        // problemas de escaping com números/strings dentro do HTML)
        marker.on('popupopen', () => {
            const btn = marker.getPopup().getElement().querySelector('.copy-coords-btn');
            if (btn) {
                btn.addEventListener('click', () => copyToClipboard(`${point.lat}, ${point.lon}`));
            }
        });

        // Ao clicar no marker, seleciona também o item correspondente no painel
        marker.on('click', () => selectPoint(index, { panTo: false }));

        markers.push(marker);

        // Distância até o ponto anterior (calculada sobre a lista já
        // deduplicada, na ordem certa)
        if (index > 0) {
            const previous = L.latLng(latLngs[index - 1]);
            const current = L.latLng(latLngs[index]);
            const distance = previous.distanceTo(current);

            const midLat = (previous.lat + current.lat) / 2;
            const midLng = (previous.lng + current.lng) / 2;

            L.marker([midLat, midLng], { icon: distanceLabelIcon(formatDistance(distance)) })
                .addTo(pointsLayer);
        }
    });

    // Desenha a polilinha
    if (latLngs.length > 1) {
        window.routeLine = L.polyline(latLngs, {
            color: 'purple',
            weight: 2.2
        }).addTo(map);

        map.fitBounds(window.routeLine.getBounds(), { padding: [10, 10] });
    } else if (latLngs.length === 1) {
        map.setView(latLngs[0], 15);
    }

    renderPanel(uniquePoints);
}

// ===== Botão para recarregar o log sem dar F5 na página =====
document.getElementById('reloadBtn')?.addEventListener('click', plotPoints);

// ===== Colapsar/expandir o painel lateral (útil em telas menores) =====
document.getElementById('togglePanelBtn')?.addEventListener('click', () => {
    document.getElementById('app').classList.toggle('panel-collapsed');
});

plotPoints();
