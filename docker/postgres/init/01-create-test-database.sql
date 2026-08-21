-- Tests run against their own database so a test run can truncate freely without
-- touching development data. See .claude/skills/database-backed-test-ecosystem.md.
CREATE DATABASE cua_test OWNER cua;
