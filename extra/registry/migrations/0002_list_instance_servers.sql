UPDATE discovery SET status = 'verified', verified_at = COALESCE(verified_at, updated_at) WHERE status = 'pending';
