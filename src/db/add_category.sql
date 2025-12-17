-- =============================================
-- Add category column to transactions table
-- =============================================
-- 
-- Run this migration to add expense categorization:
-- psql $DATABASE_URL -f src/db/add_category.sql
--
-- Or run via Supabase SQL Editor
-- =============================================

-- Add category column for expense categorization
ALTER TABLE transactions 
ADD COLUMN IF NOT EXISTS category VARCHAR(50);

-- Add index for filtering by category
CREATE INDEX IF NOT EXISTS idx_transactions_category 
ON transactions(category) 
WHERE category IS NOT NULL;

-- =============================================
-- Valid categories:
-- - utilities-bills
-- - food-dining
-- - transportation
-- - shopping-clothing
-- - health-wellness
-- - recreation-entertainment
-- - financial-obligations
-- - savings-investments
-- - miscellaneous-other
-- =============================================
