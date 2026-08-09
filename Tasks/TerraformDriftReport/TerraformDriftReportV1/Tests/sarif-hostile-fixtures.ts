// Hostile resource-address / attribute-name literals shared between the
// DriftReportSarifHostile scenario script (writes them into a plan.json and
// runs the real task) and L0.ts (which asserts on the resulting SARIF file).
// Defining them once here means the two sides can never drift apart (#898).
export const CONTROL_CHARS_ADDRESS = 'aws_instance.ctrl_\u0000\u0007\u001f_end';
export const ANSI_ESCAPE_ADDRESS = 'aws_instance.ansi_\u001b[31mRED\u001b[0m_end';
export const SCRIPT_MARKUP_ADDRESS = 'module."<script>alert(1)</script>".aws_instance.web';
export const QUOTES_BACKSLASH_ADDRESS = 'aws_instance.quote_"_and_backslash_\\_end';
export const LONG_ADDRESS = 'aws_instance.' + 'a'.repeat(100000);
export const DIRECTION_OVERRIDE_ADDRESS = 'aws_instance.file\u202egnp.exe';
export const HOSTILE_ATTR_NAME = '<img src=x onerror=alert(1)>\u0000\u001b[31m';
export const HOSTILE_ATTR_ADDRESS = 'aws_instance.hostile_attr_name_case';
