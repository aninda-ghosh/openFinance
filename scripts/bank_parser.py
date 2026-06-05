import pdfplumber
import pandas as pd
import re
import os
from collections import Counter

# CONFIGURATION
PDF_FOLDER = './statements'  # Folder containing your PDF statements
OUTPUT_FILE = 'my_subscriptions.csv'

# REGEX PATTERNS (Adjust these if your bank uses different date formats)
# Matches MM/DD or MM/DD/YYYY or MM/DD/YY at the start of a line
DATE_PATTERN = r'^(\d{1,2}/\d{1,2}(?:/\d{2,4})?)'
# Matches monetary amounts at the end of a line (e.g., 1,200.50 or -50.00)
AMOUNT_PATTERN = r'(-?\$?[\d,]+\.\d{2})[-]?$'

def extract_from_pdf(pdf_path):
    transactions = []
    filename = os.path.basename(pdf_path)
    
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            text = page.extract_text()
            if not text:
                continue
            
            for line in text.split('\n'):
                # 1. Check if line starts with a date
                date_match = re.search(DATE_PATTERN, line)
                # 2. Check if line ends with an amount
                amount_match = re.search(AMOUNT_PATTERN, line)
                
                if date_match and amount_match:
                    date_str = date_match.group(1)
                    amount_str = amount_match.group(1).replace('$', '').replace(',', '')
                    
                    # Extract description (everything between date and amount)
                    # We trim extra whitespace and common bank noise
                    desc = line[date_match.end():amount_match.start()].strip()
                    
                    try:
                        amount = float(amount_str)
                        # Filter out payments TO the credit card (usually negative or large positive depending on bank)
                        if "PAYMENT" not in desc.upper() and "THANK YOU" not in desc.upper():
                            transactions.append({
                                'Date': date_str,
                                'Description': desc,
                                'Amount': amount,
                                'Source': filename
                            })
                    except ValueError:
                        continue
                        
    return transactions

def analyze_subscriptions(df):
    # Normalize descriptions to group similar items (e.g., "NETFLIX.COM" vs "NETFLIX INC")
    # This is a basic normalization; you can add more regex cleanup here
    df['Clean_Desc'] = df['Description'].str.upper().str.split().str[0] 
    
    # 1. Frequency Check: Items appearing more than once
    frequency = df['Clean_Desc'].value_counts()
    recurring = frequency[frequency > 1].index
    
    subs = df[df['Clean_Desc'].isin(recurring)].copy()
    
    # Sort by description and date to see the timeline
    subs = subs.sort_values(by=['Clean_Desc', 'Date'])
    
    return subs

def main():
    all_data = []
    
    # 1. Loop through all PDFs
    if not os.path.exists(PDF_FOLDER):
        print(f"Error: Folder '{PDF_FOLDER}' not found.")
        return

    files = [f for f in os.listdir(PDF_FOLDER) if f.lower().endswith('.pdf')]
    print(f"Found {len(files)} PDFs. Processing...")

    for f in files:
        path = os.path.join(PDF_FOLDER, f)
        print(f"Parsing: {f}...")
        try:
            data = extract_from_pdf(path)
            all_data.extend(data)
        except Exception as e:
            print(f"Could not parse {f}: {e}")

    # 2. Create DataFrame
    if not all_data:
        print("No transactions found. Check your Regex or PDF format.")
        return

    df = pd.DataFrame(all_data)
    
    # 3. Analyze for Subscriptions
    subscription_candidates = analyze_subscriptions(df)
    
    # 4. Export
    subscription_candidates.to_csv(OUTPUT_FILE, index=False)
    print(f"\nSuccess! Found {len(df)} total transactions.")
    print(f"identified {len(subscription_candidates)} potential recurring charges.")
    print(f"Saved to {OUTPUT_FILE}")

if __name__ == "__main__":
    main()