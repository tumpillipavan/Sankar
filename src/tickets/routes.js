import dayjs from 'dayjs';
import { nowIso } from '../sqlite.js';
import { requireRole } from '../utils/auth.js';
import { z } from 'zod';

function computeDueAt(priority) {
  const hours = priority === 'urgent' ? 4 : priority === 'high' ? 8 : priority === 'normal' ? 24 : 48;
  return dayjs().add(hours, 'hour').toISOString();
}

function ticketRow(dbRow) {
  if (!dbRow) return null;
  const breached = dbRow.due_at ? dayjs().isAfter(dayjs(dbRow.due_at)) && dbRow.status !== 'resolved' && dbRow.status !== 'closed' : false;
  return { ...dbRow, sla_breached: breached };
}

export function registerTicketRoutes(app, db) {
  // Create ticket
  app.post('/api/tickets', requireRole('user', 'agent', 'admin'), (req, res) => {
    const schema = z.object({
      title: z.string().min(1),
      description: z.string().min(1),
      priority: z.enum(['low','normal','high','urgent']).optional().default('normal'),
      assignee_id: z.number().int().optional().nullable()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const { title, description, priority, assignee_id } = parsed.data;

    const requester = db.prepare('SELECT id, role FROM users WHERE email = ?').get(req.user.email || 'alice@example.com');
    if (!requester) return res.status(400).json({ error: 'Unknown requester' });

    const now = nowIso();
    const dueAt = computeDueAt(priority);
    const info = db.prepare(`
      INSERT INTO tickets (title, description, status, priority, requester_id, assignee_id, created_at, updated_at, version, due_at)
      VALUES (?, ?, 'open', ?, ?, ?, ?, ?, 0, ?)
    `).run(title, description, priority, requester.id, assignee_id ?? null, now, now, dueAt);

    db.prepare('INSERT INTO timeline (ticket_id, type, message, created_at) VALUES (?, ?, ?, ?)')
      .run(info.lastInsertRowid, 'created', `Ticket created by ${requester.id}`, now);

    const row = db.prepare('SELECT * FROM tickets WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json(ticketRow(row));
  });

  // List tickets with pagination and search
  app.get('/api/tickets', requireRole('user', 'agent', 'admin'), (req, res) => {
    const { q, limit = '10', offset = '0', status } = req.query;
    const limitNum = Math.min(50, parseInt(limit, 10) || 10);
    const offsetNum = parseInt(offset, 10) || 0;
    const params = [];
    let where = [];
    if (q) {
      where.push('(title LIKE ? OR description LIKE ? OR EXISTS (SELECT 1 FROM comments c WHERE c.ticket_id = t.id AND c.body LIKE ?))');
      const like = `%${q}%`;
      params.push(like, like, like);
    }
    if (status) {
      where.push('status = ?');
      params.push(status);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db.prepare(`
      SELECT t.* FROM tickets t
      ${whereSql}
      ORDER BY t.updated_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limitNum, offsetNum).map(ticketRow);

    const total = db.prepare(`SELECT COUNT(*) as c FROM tickets t ${whereSql}`).get(...params).c;

    res.json({ items: rows, total, limit: limitNum, offset: offsetNum });
  });

  // Get ticket by id with comments and timeline
  app.get('/api/tickets/:id', requireRole('user', 'agent', 'admin'), (req, res) => {
    const id = Number(req.params.id);
    const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
    if (!t) return res.status(404).json({ error: 'Not found' });
    const comments = db.prepare('SELECT * FROM comments WHERE ticket_id = ? ORDER BY created_at ASC').all(id);
    const timeline = db.prepare('SELECT * FROM timeline WHERE ticket_id = ? ORDER BY created_at ASC').all(id);
    res.json({ ticket: ticketRow(t), comments, timeline });
  });

  // Optimistic locking PATCH
  app.patch('/api/tickets/:id', requireRole('agent', 'admin'), (req, res) => {
    const id = Number(req.params.id);
    const schema = z.object({
      title: z.string().optional(),
      description: z.string().optional(),
      status: z.enum(['open','pending','resolved','closed']).optional(),
      priority: z.enum(['low','normal','high','urgent']).optional(),
      assignee_id: z.number().int().nullable().optional(),
      version: z.number().int()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const existing = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (existing.version !== parsed.data.version) {
      return res.status(409).json({ error: 'Version conflict' });
    }

    const updates = [];
    const params = [];
    for (const [key, value] of Object.entries(parsed.data)) {
      if (key === 'version') continue;
      if (value !== undefined) {
        updates.push(`${key} = ?`);
        params.push(value);
      }
    }
    if (updates.length === 0) return res.json(ticketRow(existing));

    // SLA recalculation if priority changed
    if (parsed.data.priority) {
      updates.push('due_at = ?');
      params.push(computeDueAt(parsed.data.priority));
    }

    const now = nowIso();
    updates.push('updated_at = ?', 'version = version + 1');
    params.push(now);

    params.push(id);

    const sql = `UPDATE tickets SET ${updates.join(', ')} WHERE id = ?`;
    db.prepare(sql).run(...params);

    db.prepare('INSERT INTO timeline (ticket_id, type, message, created_at) VALUES (?, ?, ?, ?)')
      .run(id, 'updated', 'Ticket updated', now);

    const row = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
    res.json(ticketRow(row));
  });

  // Add comment
  app.post('/api/tickets/:id/comments', requireRole('user','agent','admin'), (req, res) => {
    const id = Number(req.params.id);
    const schema = z.object({
      body: z.string().min(1),
      parent_id: z.number().int().nullable().optional()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const author = db.prepare('SELECT id FROM users WHERE email = ?').get(req.user.email || 'alice@example.com');
    if (!author) return res.status(400).json({ error: 'Unknown author' });

    const now = nowIso();
    db.prepare('INSERT INTO comments (ticket_id, author_id, parent_id, body, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, author.id, parsed.data.parent_id ?? null, parsed.data.body, now);

    db.prepare('UPDATE tickets SET last_commented_at = ?, updated_at = ?, version = version + 1 WHERE id = ?')
      .run(now, now, id);

    db.prepare('INSERT INTO timeline (ticket_id, type, message, created_at) VALUES (?, ?, ?, ?)')
      .run(id, 'comment', 'Comment added', now);

    const comments = db.prepare('SELECT * FROM comments WHERE ticket_id = ? ORDER BY created_at ASC').all(id);
    res.status(201).json({ ok: true, comments });
  });
}
