// Simple role-based auth via headers for demo
// X-User-Email: alice@example.com
// X-User-Role: user|agent|admin (validated against db)

export function authMiddleware(req, res, next) {
  const email = req.header('X-User-Email');
  const role = req.header('X-User-Role');
  req.user = { email, role };
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    const role = req.user?.role;
    if (!role || !roles.includes(role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}
