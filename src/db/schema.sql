-- =============================================
-- Mercado Pago Email Parser - Database Schema
-- =============================================
-- 
-- Run this to set up your database:
-- psql $DATABASE_URL -f src/db/schema.sql
--
-- =============================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================
-- USERS TABLE
-- =============================================

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    -- Unique ID for forwarding email: user_[external_id]@jamty.xyz
    external_id VARCHAR(100) UNIQUE NOT NULL,
    
    -- Auth credentials
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255),
    
    -- Balance (updated on each transaction)
    balance DECIMAL(15,2) DEFAULT 0,
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Fast lookups
CREATE INDEX IF NOT EXISTS idx_users_external_id ON users(external_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- =============================================
-- TRANSACTIONS TABLE
-- =============================================

-- Transaction type enum
DO $$ BEGIN
    CREATE TYPE transaction_type AS ENUM (
        'transfer_received',
        'transfer_sent',
        'payment_received',
        'payment_sent',
        'withdrawal',
        'deposit',
        'refund_received',
        'refund_sent',
        'unknown'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    
    -- Transaction data
    type transaction_type NOT NULL,
    amount DECIMAL(15,2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'ARS',
    
    -- Details
    counterparty VARCHAR(255),
    description TEXT,
    reference_id VARCHAR(100),
    
    -- Email metadata
    email_subject VARCHAR(500),
    email_from VARCHAR(255),
    received_at TIMESTAMP WITH TIME ZONE,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Prevent duplicates
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_unique_ref 
ON transactions(user_id, reference_id) 
WHERE reference_id IS NOT NULL;

-- Fast queries
CREATE INDEX IF NOT EXISTS idx_transactions_user_date 
ON transactions(user_id, created_at DESC);

-- =============================================
-- PARSING FAILURES TABLE
-- =============================================

CREATE TABLE IF NOT EXISTS parsing_failures (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id VARCHAR(100),
    reason VARCHAR(100),
    email_subject VARCHAR(500),
    email_from VARCHAR(255),
    body_preview TEXT,
    raw_data JSONB,
    resolved BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_parsing_failures_unresolved 
ON parsing_failures(resolved, created_at DESC) 
WHERE resolved = FALSE;

-- =============================================
-- AUTO-UPDATE TIMESTAMP
-- =============================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- =============================================
-- DONE!
-- =============================================
