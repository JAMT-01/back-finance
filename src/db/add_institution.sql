-- Migration: Add institution column to transactions table
-- Run this in Supabase SQL Editor

-- Add institution column to track which financial institution the transaction came from
ALTER TABLE transactions 
ADD COLUMN IF NOT EXISTS institution VARCHAR(50) DEFAULT 'mercadopago';

-- Create index for filtering by institution
CREATE INDEX IF NOT EXISTS idx_transactions_institution ON transactions(institution);

-- Comment describing the column
COMMENT ON COLUMN transactions.institution IS 'ID of the financial institution (mercadopago, uala, galicia, etc.)';
