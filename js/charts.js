'use strict';

const Charts = (() => {

  const NF0 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
  const NF1 = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  // Kalorienring, dreistufig: bis Ziel grün, über Ziel aber unter TDEE gelb,
  // über TDEE dunkles Orange. Zahl in der Mitte je Stufe.
  function ring(eaten, goal, tdee) {
    const size = 220, cx = size / 2, cy = size / 2, r = 92, stroke = 15;
    const circumference = 2 * Math.PI * r;
    const safeGoal = Math.max(goal, 1);
    const safeTdee = Math.max(tdee || safeGoal, safeGoal);
    const ratio = Math.min(eaten / safeGoal, 1);
    const dash = circumference * ratio;

    let progressColor, bigText, subText, subText2 = '';
    if (eaten <= safeGoal) {
      progressColor = 'var(--accent)';
      bigText = NF0.format(Math.round(safeGoal - eaten));
      subText = 'kcal übrig';
    } else if (eaten <= safeTdee) {
      progressColor = 'var(--caution)';
      bigText = NF0.format(Math.round(eaten - safeGoal));
      subText = 'kcal über Ziel';
      subText2 = 'noch im Defizit';
    } else {
      progressColor = 'var(--over)';
      bigText = NF0.format(Math.round(eaten - safeTdee));
      subText = 'kcal Überschuss';
    }

    const progress = eaten > 0
      ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${progressColor}" stroke-width="${stroke}"
        stroke-linecap="round" stroke-dasharray="${dash.toFixed(1)} ${circumference.toFixed(1)}"
        transform="rotate(-90 ${cx} ${cy})" class="ring-progress"/>`
      : '';
    return `<svg viewBox="0 0 ${size} ${size}" class="ring" role="img" aria-label="${bigText} ${subText}${subText2 ? ' – ' + subText2 : ''}">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--ring-track)" stroke-width="${stroke}"/>
      ${progress}
      <text x="${cx}" y="${cy - 4}" text-anchor="middle" class="ring-big">${bigText}</text>
      <text x="${cx}" y="${cy + 24}" text-anchor="middle" class="ring-sub">${subText}</text>
      ${subText2 ? `<text x="${cx}" y="${cy + 42}" text-anchor="middle" class="ring-sub2">${subText2}</text>` : ''}
    </svg>`;
  }

  // Gewichtsdiagramm: Punkte = Rohwerte, Linie = 7-Tage-Trend, gestrichelt = Ziel,
  // optionale Meilenstein-Marker [{ threshold, key, trend }] an den Trend-Punkten.
  // points: [{ key, weight, trend }] aufsteigend, target: Zielgewicht oder null.
  function weightChart(points, target, marks) {
    const w = 340, h = 190, padL = 38, padR = 10, padT = 12, padB = 24;
    if (points.length === 0) {
      return `<svg viewBox="0 0 ${w} ${h}" class="chart">
        <text x="${w / 2}" y="${h / 2}" text-anchor="middle" class="chart-empty">Noch keine Wiegeeinträge</text>
      </svg>`;
    }
    const values = points.map(p => p.weight).concat(points.map(p => p.trend));
    if (target != null) values.push(target);
    let min = Math.min(...values), max = Math.max(...values);
    const pad = Math.max((max - min) * 0.12, 0.6);
    min -= pad; max += pad;

    const t0 = dateMs(points[0].key);
    const t1 = dateMs(points[points.length - 1].key);
    const span = Math.max(t1 - t0, 86400000);
    const x = key => padL + (dateMs(key) - t0) / span * (w - padL - padR);
    const y = v => padT + (max - v) / (max - min) * (h - padT - padB);

    let svg = `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img" aria-label="Gewichtsverlauf">`;

    // Y-Achse: 3 Hilfslinien
    for (let i = 0; i <= 2; i++) {
      const v = min + (max - min) * i / 2;
      const yy = y(v);
      svg += `<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${w - padR}" y2="${yy.toFixed(1)}" class="grid-line"/>`;
      svg += `<text x="${padL - 5}" y="${(yy + 3).toFixed(1)}" text-anchor="end" class="axis-label">${NF1.format(v)}</text>`;
    }

    // X-Achse: erste/mittlere/letzte Beschriftung
    const labelIdx = points.length > 2 ? [0, Math.floor(points.length / 2), points.length - 1] : [0, points.length - 1];
    [...new Set(labelIdx)].forEach(i => {
      const p = points[i];
      svg += `<text x="${x(p.key).toFixed(1)}" y="${h - 6}" text-anchor="middle" class="axis-label">${shortDate(p.key)}</text>`;
    });

    if (target != null) {
      const ty = y(target);
      svg += `<line x1="${padL}" y1="${ty.toFixed(1)}" x2="${w - padR}" y2="${ty.toFixed(1)}" class="target-line"/>`;
    }

    if (points.length > 1) {
      const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.key).toFixed(1)},${y(p.trend).toFixed(1)}`).join('');
      svg += `<path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
    }
    points.forEach(p => {
      svg += `<circle cx="${x(p.key).toFixed(1)}" cy="${y(p.weight).toFixed(1)}" r="3" class="dot"/>`;
    });

    // Meilenstein-Marker: dezente Punkte am Trend, nur die letzten 4 beschriftet
    if (Array.isArray(marks) && marks.length) {
      const visible = marks
        .filter(m => m.key >= points[0].key && m.key <= points[points.length - 1].key)
        .sort((a, b) => a.key < b.key ? -1 : 1);
      const labelFrom = Math.max(0, visible.length - 4);
      visible.forEach((m, i) => {
        const mx = x(m.key), my = y(m.trend);
        svg += `<circle cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="4" class="milestone-dot"/>`;
        if (i >= labelFrom) {
          const ly = Math.max(padT + 8, my - 9);
          svg += `<text x="${mx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" class="milestone-label">&lt; ${NF0.format(m.threshold)} kg</text>`;
        }
      });
    }

    svg += '</svg>';
    return svg;
  }

  // Balkendiagramm kcal/Tag mit Ziellinie. bars: [{ key, kcal, goal }] aufsteigend.
  function barChart(bars) {
    const w = 340, h = 170, padL = 34, padR = 6, padT = 10, padB = 22;
    if (bars.length === 0) {
      return `<svg viewBox="0 0 ${w} ${h}" class="chart">
        <text x="${w / 2}" y="${h / 2}" text-anchor="middle" class="chart-empty">Noch keine Einträge</text>
      </svg>`;
    }
    const goals = bars.map(b => b.goal).filter(g => g > 0);
    const avgGoal = goals.length ? goals.reduce((a, b) => a + b, 0) / goals.length : 0;
    const max = Math.max(...bars.map(b => b.kcal), avgGoal, 100) * 1.12;
    const innerW = w - padL - padR;
    const step = innerW / bars.length;
    const barW = Math.min(step * 0.62, 20);
    const y = v => padT + (1 - v / max) * (h - padT - padB);

    let svg = `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img" aria-label="Kalorien pro Tag">`;

    for (let i = 0; i <= 2; i++) {
      const v = max * i / 2;
      svg += `<line x1="${padL}" y1="${y(v).toFixed(1)}" x2="${w - padR}" y2="${y(v).toFixed(1)}" class="grid-line"/>`;
      svg += `<text x="${padL - 4}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end" class="axis-label">${NF0.format(v)}</text>`;
    }

    bars.forEach((b, i) => {
      const bx = padL + step * i + (step - barW) / 2;
      const by = y(b.kcal);
      const bh = Math.max(h - padB - by, b.kcal > 0 ? 2 : 0);
      const cls = b.goal > 0 && b.kcal > b.goal ? 'bar bar-over' : 'bar';
      svg += `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" rx="3" class="${cls}"/>`;
      if (i % 2 === 0 || bars.length <= 7) {
        svg += `<text x="${(bx + barW / 2).toFixed(1)}" y="${h - 5}" text-anchor="middle" class="axis-label">${dayNum(b.key)}</text>`;
      }
    });

    if (avgGoal > 0) {
      svg += `<line x1="${padL}" y1="${y(avgGoal).toFixed(1)}" x2="${w - padR}" y2="${y(avgGoal).toFixed(1)}" class="target-line"/>`;
    }

    svg += '</svg>';
    return svg;
  }

  function dateMs(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d).getTime();
  }

  function shortDate(key) {
    const [, m, d] = key.split('-').map(Number);
    return `${d}.${m}.`;
  }

  function dayNum(key) {
    return String(Number(key.split('-')[2]));
  }

  return { ring, weightChart, barChart };
})();
