/**
 * PermissionService.js
 * Replicates the desktop app's granular, dependency-aware permission logic.
 */

const HIERARCHY = {
  "delete_member": ["update_member", "read_member"],
  "update_member": ["create_member", "read_member"],
  "create_member": ["read_member"],
  
  "delete_remittance": ["update_remittance", "read_remittance"],
  "update_remittance": ["create_remittance", "read_remittance", "approve_remittance"],
  "approve_remittance": ["read_remittance"],
  "create_remittance": ["read_remittance"],
  "reverse_remittance": ["read_remittance"],
  
  "delete_enterprise": ["update_enterprise", "read_enterprise"],
  "update_enterprise": ["create_enterprise", "read_enterprise"],
  "create_enterprise": ["read_enterprise"],
  
  "settings_manage": ["read_member", "read_enterprise"],
  
  "create_reconcile": ["read_reconcile"],
  
  "admin": ["*"], // Special keyword for all permissions
  "member_approval": [], // Permission to approve/decline join requests
};

/**
 * Recursively checks if 'required' is a child of 'granted' in the hierarchy.
 */
function isDescendant(granted, required) {
  const children = HIERARCHY[granted] || [];
  if (children.includes(required)) return true;
  for (const child of children) {
    if (isDescendant(child, required)) return true;
  }
  return false;
}

/**
 * Checks if the user has the required permission, considering hierarchy.
 * @param {string|string[]} userPermissions - Comma-separated string or array of permissions.
 * @param {string} requiredPermission - The specific permission string to check for.
 * @returns {boolean}
 */
export function hasPermission(userPermissions, requiredPermission) {
  if (!userPermissions) return false;

  const permsSet = new Set();
  if (Array.isArray(userPermissions)) {
    userPermissions.forEach(p => p && permsSet.add(p.trim().toLowerCase()));
  } else {
    userPermissions.split(',').forEach(p => p && permsSet.add(p.trim().toLowerCase()));
  }

  // Admin keywords
  if (permsSet.has('admin') || permsSet.has('*') || permsSet.has('all')) {
    return true;
  }

  const reqLower = requiredPermission.toLowerCase();
  if (permsSet.has(reqLower)) {
    return true;
  }

  // Check hierarchy
  for (const granted of permsSet) {
    if (isDescendant(granted, reqLower)) {
      return true;
    }
  }

  return false;
}

/**
 * Returns all unique permission strings defined in the system.
 */
export function getAllPermissions() {
  return [
    "dashboard_view",
    "read_member", "create_member", "update_member", "delete_member", "member_approval",
    "read_remittance", "create_remittance", "update_remittance", "delete_remittance", "approve_remittance", "reverse_remittance",
    "read_ledger", "read_coop_ledger",
    "read_report",
    "read_reconcile", "create_reconcile",
    "settings_manage"
  ].sort();
}
