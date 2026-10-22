"""Validate model-generated lesson titles at both worker and storage boundaries."""
def generated_title(value):
    if not isinstance(value,str):raise ValueError('Invalid generated lesson title. Retry the import.')
    title=value.strip()
    if not title or len(title)>30 or any(c in title for c in '\r\n'):
        raise ValueError('Invalid generated lesson title. Retry the import.')
    return title
